"""
geometry_service.py — Phase 1: shape classification, measurement plan generation,
and area computation from real measured values.

Why this exists
---------------
The floor plan image is NOT to scale (the drawings say so explicitly). Therefore the
polygon is used ONLY to (a) classify the room shape and (b) decide which physically
measurable, wall-to-wall distances to request from the stager. The final area is
computed from the values the stager actually measures, via a self-contained "area
recipe" that the frontend can evaluate identically (single source of truth).

Coordinate space
-----------------
Polygon points are normalized fractions (x, y in 0..1) of the image. Because x and y
are scaled independently by the image dimensions, a real right angle is NOT a right
angle in raw fraction space for a non-square image. All angle/shape reasoning here is
done in ASPECT-CORRECTED space:

    X = x * aspect_ratio, Y = y      where aspect_ratio = image_width_px / image_height_px

This mirrors the existing frontend logic in measure/page.tsx.

Scope
-----
Phase 1a (this file): triangle, rectangle, rotated rectangle, trapezoid, convex
quadrilateral. Orthogonal L / rectilinear complex and concave / free polygons are
classified but their plan is marked supported=False until Phase 1b/1c.
"""
import math
from typing import Dict, List, Optional, Tuple

Point = Dict[str, float]

# ── Tolerances ────────────────────────────────────────────────────────────────
RIGHT_ANGLE_TOL_DEG = 12.0   # how close to 90 deg to accept as a right angle
VISVALINGAM_AREA_FRAC = 0.012  # drop vertices whose triangle area is below this fraction of the room
PARALLEL_TOL_DEG = 10.0      # how close to parallel two edges must be
AXIS_TOL = 0.04              # fraction: edge treated as horizontal/vertical if the
                             # smaller delta is within this fraction of the larger
CLUSTER_SNAP_FRAC = 0.06     # wall lines within this fraction of the ROOM's own extent on an
                             # axis are the same wall line. Relative, so a room classifies the
                             # same however large it is drawn. Chosen by sweeping 0.02-0.12 over
                             # all stored rooms: 0.02-0.06 hold the pre-change worst-case
                             # reconstruction error (1.6%), while 0.08+ let it rise to 4.0%.


# ── Low level geometry helpers ─────────────────────────────────────────────────
def _corrected(points: List[Point], aspect_ratio: float) -> List[Tuple[float, float]]:
    ar = aspect_ratio if aspect_ratio and aspect_ratio > 0 else 1.0
    return [(p["x"] * ar, p["y"]) for p in points]


def _dist(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _interior_angles_deg(pts: List[Tuple[float, float]]) -> List[float]:
    """Unsigned angle (0..180) at each vertex, between its two adjacent edges."""
    n = len(pts)
    angles: List[float] = []
    for i in range(n):
        prev = pts[(i - 1) % n]
        cur = pts[i]
        nxt = pts[(i + 1) % n]
        v1 = (prev[0] - cur[0], prev[1] - cur[1])
        v2 = (nxt[0] - cur[0], nxt[1] - cur[1])
        m1 = math.hypot(*v1)
        m2 = math.hypot(*v2)
        if m1 == 0 or m2 == 0:
            angles.append(0.0)
            continue
        cosv = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2)))
        angles.append(math.degrees(math.acos(cosv)))
    return angles


def _signed_area(pts: List[Tuple[float, float]]) -> float:
    n = len(pts)
    s = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def _is_convex(pts: List[Tuple[float, float]]) -> bool:
    """True if the simple polygon has no reflex vertex (all cross products same sign)."""
    n = len(pts)
    if n < 4:
        return True
    sign = 0
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        c = pts[(i + 2) % n]
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cross) < 1e-12:
            continue
        cur = 1 if cross > 0 else -1
        if sign == 0:
            sign = cur
        elif cur != sign:
            return False
    return True


def _edge_is_axis_aligned(p1: Point, p2: Point) -> bool:
    dx = abs(p2["x"] - p1["x"])
    dy = abs(p2["y"] - p1["y"])
    lo, hi = min(dx, dy), max(dx, dy)
    return hi > 0 and lo <= AXIS_TOL * hi


def _all_axis_aligned(points: List[Point]) -> bool:
    n = len(points)
    return all(_edge_is_axis_aligned(points[i], points[(i + 1) % n]) for i in range(n))


def _edge_angle_deg(pts: List[Tuple[float, float]], i: int) -> float:
    n = len(pts)
    a = pts[i]
    b = pts[(i + 1) % n]
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180.0


def _parallel_pair(pts: List[Tuple[float, float]]) -> Optional[Tuple[int, int]]:
    """For a quad, return the index pair of one parallel edge pair, if any."""
    n = len(pts)
    for i in range(n):
        for j in range(i + 1, n):
            diff = abs(_edge_angle_deg(pts, i) - _edge_angle_deg(pts, j))
            diff = min(diff, 180.0 - diff)
            if diff <= PARALLEL_TOL_DEG:
                return (i, j)
    return None


def _direction_label(p1: Point, p2: Point) -> str:
    dx = p2["x"] - p1["x"]
    dy = p2["y"] - p1["y"]
    if abs(dx) > abs(dy) * 2:
        return "right side" if dx > 0 else "left side"
    if abs(dy) > abs(dx) * 2:
        return "bottom" if dy > 0 else "top"
    return "diagonal"


def _perp_foot(p: Tuple[float, float], a: Tuple[float, float], b: Tuple[float, float]) -> Tuple[float, float]:
    """Foot of the perpendicular from point p onto the line through a-b."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    if denom == 0:
        return a
    t = ((px - ax) * dx + (py - ay) * dy) / denom
    return (ax + t * dx, ay + t * dy)


def heron(a: float, b: float, c: float) -> float:
    s = (a + b + c) / 2.0
    val = s * (s - a) * (s - b) * (s - c)
    return math.sqrt(val) if val > 0 else 0.0


def _point_in_polygon(x: float, y: float, poly: List[Tuple[float, float]]) -> bool:
    """Ray casting test. Works in raw fraction space (affine invariant)."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _tri_sign(a: Tuple[float, float], b: Tuple[float, float], c: Tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _point_in_triangle(p, a, b, c) -> bool:
    d1 = _tri_sign(p, a, b)
    d2 = _tri_sign(p, b, c)
    d3 = _tri_sign(p, c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def _triangulate(pts: List[Tuple[float, float]]) -> Optional[List[Tuple[int, int, int]]]:
    """Ear clipping for a simple polygon. Returns triangles as original vertex index
    triples, or None if triangulation fails (degenerate / self-intersecting)."""
    n = len(pts)
    if n < 3:
        return None
    idx = list(range(n))
    if _signed_area(pts) < 0:   # ensure counter-clockwise
        idx.reverse()
    triangles: List[Tuple[int, int, int]] = []
    guard = 0
    while len(idx) > 3 and guard < 5000:
        guard += 1
        m = len(idx)
        made = False
        for a in range(m):
            i0, i1, i2 = idx[(a - 1) % m], idx[a], idx[(a + 1) % m]
            A, B, C = pts[i0], pts[i1], pts[i2]
            if _tri_sign(A, B, C) <= 0:   # reflex or collinear for a CCW polygon
                continue
            if any(k not in (i0, i1, i2) and _point_in_triangle(pts[k], A, B, C) for k in idx):
                continue
            triangles.append((i0, i1, i2))
            del idx[a]
            made = True
            break
        if not made:
            return None
    if len(idx) == 3:
        triangles.append((idx[0], idx[1], idx[2]))
    return triangles


# ── Classification ──────────────────────────────────────────────────────────────
def classify_shape(points: List[Point], aspect_ratio: float = 1.0) -> str:
    """Return one of: invalid, triangle, rectangle, rotated_rectangle, trapezoid,
    quad, orthogonal, polygon. Angles are a hint (the drawing is not to scale)."""
    n = len(points)
    if n < 3:
        return "invalid"
    pts = _corrected(points, aspect_ratio)
    angles = _interior_angles_deg(pts)
    all_right = all(abs(a - 90.0) <= RIGHT_ANGLE_TOL_DEG for a in angles)

    if n == 3:
        return "triangle"
    if n == 4:
        if all_right:
            return "rectangle" if _all_axis_aligned(points) else "rotated_rectangle"
        return "trapezoid" if _parallel_pair(pts) else "quad"
    # n > 4
    if all_right:
        return "orthogonal"
    return "polygon"


# ── Plan building helpers ─────────────────────────────────────────────────────
def _item(item_id: str, label: str, kind: str, p_from: Point, p_to: Point,
          rel_len: float, required: bool = True, feasible: bool = True,
          note: str = "") -> dict:
    return {
        "id": item_id,
        "label": label,
        "kind": kind,                 # side | diagonal | height
        "from": {"x": p_from["x"], "y": p_from["y"]},
        "to": {"x": p_to["x"], "y": p_to["y"]},
        "rel_len": round(rel_len, 6),  # length in aspect-corrected space, for estimates
        "required": required,
        "feasible": feasible,
        "note": note,
    }


def _mid(p1: Point, p2: Point) -> Point:
    return {"x": (p1["x"] + p2["x"]) / 2.0, "y": (p1["y"] + p2["y"]) / 2.0}


def _drop_collinear(points: List[Point], aspect_ratio: float, tol_deg: float = 8.0) -> List[Point]:
    """Remove vertices whose interior angle is ~180 deg (a redundant point in the middle
    of a straight wall). Repeats until stable."""
    pts = [dict(p) for p in points]
    changed = True
    while changed and len(pts) > 3:
        changed = False
        angles = _interior_angles_deg(_corrected(pts, aspect_ratio))
        for i in range(len(pts)):
            if abs(angles[i] - 180.0) < tol_deg:
                del pts[i]
                changed = True
                break
    return pts


def _rectilinearize(points: List[Point], aspect_ratio: float, iters: int = 12) -> List[Point]:
    """Force a near-rectilinear polygon to true horizontal/vertical edges by relaxation:
    each edge is classed H or V by its dominant direction, then shared endpoints are
    averaged onto a common line. Recovers the true (few) wall lines from a slightly
    skewed drawing, so the grid decomposition stops exploding into many tiny segments."""
    ar = aspect_ratio if aspect_ratio and aspect_ratio > 0 else 1.0
    n = len(points)
    pts = [dict(p) for p in points]
    orient = []
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        dx = abs((b["x"] - a["x"]) * ar)
        dy = abs(b["y"] - a["y"])
        orient.append("H" if dx >= dy else "V")
    for _ in range(iters):
        for i in range(n):
            a, b = pts[i], pts[(i + 1) % n]
            if orient[i] == "H":
                m = (a["y"] + b["y"]) / 2.0
                a["y"] = b["y"] = m
            else:
                m = (a["x"] + b["x"]) / 2.0
                a["x"] = b["x"] = m
    return pts


def _cluster_snap(points: List[Point], eps_frac: Optional[float] = None) -> List[Point]:
    """Merge x (and y) coordinates that are close to each other onto a shared value, collapsing
    near-duplicate wall lines left after rectilinearization.

    The tolerance is a fraction of the ROOM's own extent on that axis, never a fraction of the
    image. With an absolute epsilon the same room classified differently purely because of how
    large it was drawn: an L-shaped room drawn at 3% of the page had its distinct wall lines
    merged and fell out of the clean all-walls plan into a 5-item offsets plan, which penalised
    exactly the small rooms (WCs, storage, ensuites) that are common on a multi-room plan."""
    def cluster(vals: List[float], eps: float) -> Dict[float, float]:
        s = sorted(set(vals))
        groups, cur = [], [s[0]]
        for v in s[1:]:
            if v - cur[-1] <= eps:
                cur.append(v)
            else:
                groups.append(cur); cur = [v]
        groups.append(cur)
        mapping = {}
        for grp in groups:
            avg = sum(grp) / len(grp)
            for v in grp:
                mapping[v] = avg
        return mapping
    frac = CLUSTER_SNAP_FRAC if eps_frac is None else eps_frac   # read at call time, so it is tunable
    xv = [p["x"] for p in points]
    yv = [p["y"] for p in points]
    xs = cluster(xv, (max(xv) - min(xv)) * frac)
    ys = cluster(yv, (max(yv) - min(yv)) * frac)
    return [{"x": xs[p["x"]], "y": ys[p["y"]]} for p in points]


def _poly_area(corr: List[Tuple[float, float]]) -> float:
    return abs(_signed_area(corr))


def _visvalingam(points: List[Point], aspect_ratio: float, area_frac: float = 0.012) -> List[Point]:
    """Orientation-independent noise removal: repeatedly drop the vertex whose triangle
    (with its two neighbours) has the smallest area, while that area is below a fraction
    of the whole polygon's area. Works at any rotation, so an over-detected rotated
    rectangle collapses to its real corners while genuine corners survive."""
    pts = [dict(p) for p in points]
    if len(pts) <= 3:
        return pts
    total = _poly_area(_corrected(pts, aspect_ratio)) or 1e-9
    thresh = area_frac * total
    while len(pts) > 3:
        corr = _corrected(pts, aspect_ratio)
        n = len(pts)
        best_i, best_a = -1, None
        for i in range(n):
            a, b, c = corr[(i - 1) % n], corr[i], corr[(i + 1) % n]
            tri = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0
            if best_a is None or tri < best_a:
                best_a, best_i = tri, i
        if best_a is not None and best_a < thresh:
            del pts[best_i]
        else:
            break
    return pts


def simplify_polygon(points: List[Point], aspect_ratio: float = 1.0) -> List[Point]:
    """Clean an AI polygon before planning. Orientation-independent noise removal
    (Visvalingam) drops insignificant vertices at any rotation; then for right-angled
    rooms the shape is straightened to axis and near-equal wall lines merged. Does NOT
    force a shape: genuine corners survive; only drawing noise and slight skew are
    removed. A degeneracy guard reverts to the original if cleanup collapsed the area."""
    original = [dict(p) for p in points]
    pts = _visvalingam(points, aspect_ratio, area_frac=VISVALINGAM_AREA_FRAC)
    pts = _drop_collinear(pts, aspect_ratio)
    if len(pts) >= 4:
        angles = _interior_angles_deg(_corrected(pts, aspect_ratio))
        near = sum(1 for a in angles if abs(a - 90.0) <= RIGHT_ANGLE_TOL_DEG)
        # Predominantly rectilinear: tolerate one noisy corner so a real right-angled
        # room with a single mis-detected vertex still straightens. A genuine chamfer
        # or diagonal (two or more off-90 corners) is left as a free polygon.
        if near >= len(angles) - 1:
            pts = _rectilinearize(pts, aspect_ratio)
            pts = _cluster_snap(pts)
            pts = _drop_collinear(pts, aspect_ratio, tol_deg=5.0)
    if len(pts) < 3 or _poly_area(_corrected(pts, aspect_ratio)) < 1e-5:
        return original
    return pts


def _dominant_angle_rad(corr: List[Tuple[float, float]]) -> float:
    """Length-weighted dominant wall orientation, in radians, folded to the [-45, 45] deg
    principal range (rectilinear walls come in perpendicular pairs, period 90 deg)."""
    s = c = 0.0
    n = len(corr)
    for i in range(n):
        a, b = corr[i], corr[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        ang = math.atan2(dy, dx)
        s += L * math.sin(4 * ang)
        c += L * math.cos(4 * ang)
    return math.atan2(s, c) / 4.0


def _segments_cross(p1: Tuple[float, float], p2: Tuple[float, float],
                    p3: Tuple[float, float], p4: Tuple[float, float]) -> bool:
    """True when segment p1-p2 properly crosses p3-p4 (an interior crossing, not a shared
    endpoint or a collinear touch)."""
    def orient(a, b, c) -> int:
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(v) < 1e-12:
            return 0
        return 1 if v > 0 else -1
    o1, o2 = orient(p1, p2, p3), orient(p1, p2, p4)
    o3, o4 = orient(p3, p4, p1), orient(p3, p4, p2)
    return 0 not in (o1, o2, o3, o4) and o1 != o2 and o3 != o4


def polygon_validity(corr: List[Tuple[float, float]]) -> Optional[str]:
    """Reject outlines no measurement plan can honestly describe. Returns a reason, or None if
    the polygon is usable.

    Review lets a stager drag vertices freely, so a self-intersecting ("bowtie") or collapsed
    outline is reachable — and without this gate build_plan happily returned a confident plan
    for one (a bowtie classified as a trapezoid), which violates the rule that the engine never
    silently emits a wrong or unmeasurable plan.

    The area test is a pure degeneracy test (area is essentially zero), NOT a size threshold —
    a genuinely thin room such as a corridor must still be measurable."""
    distinct = {(round(x, 9), round(y, 9)) for x, y in corr}
    if len(corr) < 3 or len(distinct) < 3:
        return "degenerate"
    if abs(_signed_area(corr)) <= 1e-12:
        return "degenerate"          # collinear or zero-area
    n = len(corr)
    for i in range(n):
        for j in range(i + 1, n):
            if j == i + 1 or (i == 0 and j == n - 1):
                continue             # edges sharing a vertex may legitimately touch
            if _segments_cross(corr[i], corr[(i + 1) % n], corr[j], corr[(j + 1) % n]):
                return "self_intersecting"
    return None


def _rotate_pt(p: Tuple[float, float], ang: float, cen: Tuple[float, float]) -> Tuple[float, float]:
    ca, sa = math.cos(ang), math.sin(ang)
    x, y = p[0] - cen[0], p[1] - cen[1]
    return (cen[0] + x * ca - y * sa, cen[1] + x * sa + y * ca)


def build_plan(points: List[Point], aspect_ratio: float = 1.0) -> dict:
    """Plan generation with rotation normalization: rotated/diagonal rooms are planned in
    a de-rotated, axis-aligned frame (so classification and decomposition stay clean and
    few-segment), then each measurement segment's endpoints are rotated back to the
    original orientation for display. Axis-aligned rooms pass straight through."""
    ar = aspect_ratio if aspect_ratio and aspect_ratio > 0 else 1.0
    corr = _corrected(points, ar)
    # Refuse outlines no honest plan can describe, rather than returning a confident wrong one.
    bad = polygon_validity(corr)
    if bad:
        return {"shape_class": "invalid", "supported": False, "items": [],
                "recipe": None, "reason": bad}
    if len(corr) < 3:
        return _build_plan_core(points, ar)
    theta = _dominant_angle_rad(corr)
    if abs(theta) < math.radians(2.0):
        return _build_plan_core(points, ar)
    cen = (sum(p[0] for p in corr) / len(corr), sum(p[1] for p in corr) / len(corr))
    rot_points = [{"x": X, "y": Y} for (X, Y) in (_rotate_pt(p, -theta, cen) for p in corr)]
    plan = _build_plan_core(rot_points, 1.0)
    if plan.get("supported"):
        for it in plan["items"]:
            for key in ("from", "to"):
                Xb, Yb = _rotate_pt((it[key]["x"], it[key]["y"]), theta, cen)
                it[key] = {"x": Xb / ar, "y": Yb}
    return plan


def _build_plan_core(points: List[Point], aspect_ratio: float = 1.0) -> dict:
    """Return {shape_class, supported, items[], recipe}. Area is computed later from
    measured values via compute_area(recipe, values)."""
    points = simplify_polygon(points, aspect_ratio)
    shape = classify_shape(points, aspect_ratio)
    pts = _corrected(points, aspect_ratio)
    n = len(points)

    def edge_len(i: int) -> float:
        return _dist(pts[i], pts[(i + 1) % n])

    def edge_item(item_id: str, i: int, required: bool = True) -> dict:
        p1, p2 = points[i], points[(i + 1) % n]
        return _item(item_id, f"Wall {i + 1} ({_direction_label(p1, p2)})", "side",
                     p1, p2, edge_len(i), required)

    if shape == "triangle":
        items = [edge_item(f"m{i}", i) for i in range(3)]
        recipe = {"method": "heron", "items": ["m0", "m1", "m2"]}
        return {"shape_class": shape, "supported": True, "items": items, "recipe": recipe}

    if shape in ("rectangle", "rotated_rectangle"):
        items = [edge_item("m0", 0), edge_item("m1", 1)]
        recipe = {"method": "product", "items": ["m0", "m1"]}
        return {"shape_class": shape, "supported": True, "items": items, "recipe": recipe}

    if shape == "trapezoid":
        i, j = _parallel_pair(pts)  # the two parallel edges
        a = edge_item("m0", i)
        b = edge_item("m1", j)
        # height = perpendicular distance between the two parallel walls
        mid_i = _mid(points[i], points[(i + 1) % n])
        mid_j = _mid(points[j], points[(j + 1) % n])
        h_rel = _dist(pts[i], _perp_foot(pts[i], pts[j], pts[(j + 1) % n]))
        h_item = _item("m2", "Perpendicular distance between the two parallel walls",
                       "height", mid_i, mid_j, h_rel, required=True)
        recipe = {"method": "trapezoid", "a": "m0", "b": "m1", "h": "m2"}
        return {"shape_class": shape, "supported": True, "items": [a, b, h_item], "recipe": recipe}

    if shape == "orthogonal":
        ortho = _build_orthogonal_plan(points, aspect_ratio)
        if ortho:
            return {"shape_class": shape, "supported": True, **ortho}

    if shape in ("quad", "polygon"):   # angled / free rooms
        # Prefer baseline + perpendicular offsets (all measurable, no diagonal across the
        # room). Fall back to triangulation only if offsets cannot be built.
        off = _build_offset_plan(points, aspect_ratio)
        if off:
            return {"shape_class": shape, "supported": True, **off}
        tri = _build_triangulated_plan(points, aspect_ratio)
        if tri:
            return {"shape_class": shape, "supported": True, **tri}

    return {"shape_class": shape, "supported": False, "items": [], "recipe": None}


def _build_triangulated_plan(points: List[Point], aspect_ratio: float) -> Optional[dict]:
    """General simple polygon via triangulation. The stager measures every wall plus
    the diagonals used by the triangulation; area is the sum of triangle areas (Heron).
    Diagonals may be blocked, so each is flagged with a measure-around note."""
    n = len(points)
    pts = _corrected(points, aspect_ratio)
    tris = _triangulate(pts)
    if not tris:
        return None

    diag_note = ("If a pillar or furniture blocks this diagonal, measure it in parts "
                 "around the obstacle and enter the sum.")
    items: Dict[str, dict] = {}

    def side_id(u: int, v: int) -> str:
        adjacent = (u + 1) % n == v or (v + 1) % n == u
        if adjacent:
            e = n - 1 if {u, v} == {0, n - 1} else min(u, v)
            return f"m{e}"
        return f"d{min(u, v)}_{max(u, v)}"

    def ensure_item(u: int, v: int) -> str:
        sid = side_id(u, v)
        if sid not in items:
            if sid.startswith("m"):
                e = int(sid[1:])
                a, b = points[e], points[(e + 1) % n]
                label = f"Wall {e + 1} ({_direction_label(a, b)})"
                items[sid] = _item(sid, label, "side", a, b, _dist(pts[u], pts[v]))
            else:
                label = f"Diagonal (corner {u + 1} to corner {v + 1})"
                items[sid] = _item(sid, label, "diagonal", points[u], points[v],
                                   _dist(pts[u], pts[v]), feasible=False, note=diag_note)
        return sid

    triangles_ids: List[List[str]] = []
    for (a, b, c) in tris:
        triangles_ids.append([ensure_item(a, b), ensure_item(b, c), ensure_item(c, a)])

    recipe = {"method": "heron_triangles", "triangles": triangles_ids}
    return {"items": list(items.values()), "recipe": recipe}


def _build_offset_plan(points: List[Point], aspect_ratio: float) -> Optional[dict]:
    """Angled room WITHOUT diagonals: choose a baseline wall, then for every other corner
    request a distance ALONG the baseline plus a perpendicular OFFSET from it. Both run along
    or square to a wall (measurable with a laser or tape); nothing crosses the open room.
    Corners are reconstructed from along/offset and the area is the shoelace.

    EVERY edge is tried as the baseline (longest first), not only the single longest wall, and
    the first edge on which every corner's perpendicular foot lands on the baseline wall is
    used. Trying only the longest wall fails for many angled rooms at some aspect ratios (the
    longest wall in aspect-corrected space is not always a usable baseline), which forced a
    fall back to un-measurable diagonals. Returns None only if NO edge works as a baseline, so
    the caller can fall back to triangulation."""
    ar = aspect_ratio if aspect_ratio and aspect_ratio > 0 else 1.0
    n = len(points)
    if n < 3:
        return None
    corr = _corrected(points, ar)
    # Try every wall as a baseline, in BOTH directions (which endpoint is the "start" corner
    # the along-distances are measured from), longest first. A negative "along" cannot be
    # measured as a positive distance from the start; reversing the direction turns that corner
    # into a measurable positive along, so more angled rooms get a diagonal-free plan.
    cands = []
    for i in range(n):
        L = _dist(corr[i], corr[(i + 1) % n])
        cands.append((L, i, i, (i + 1) % n))       # forward:  start=i,   end=i+1
        cands.append((L, i, (i + 1) % n, i))       # reversed: start=i+1, end=i
    cands.sort(key=lambda c: c[0], reverse=True)
    for _L, edge, bstart, bend in cands:
        plan = _offset_plan_from_baseline(points, corr, ar, edge, bstart, bend)
        if plan is not None:
            return plan
    return None


def _offset_plan_from_baseline(points: List[Point], corr: List[Tuple[float, float]],
                               ar: float, edge: int, bstart: int, bend: int) -> Optional[dict]:
    """Build an ``offsets`` plan using wall ``edge`` as the baseline, with along-distances
    measured from corner ``bstart`` toward corner ``bend``. Returns None if any corner's
    perpendicular foot falls before the start or too far past the end (that direction is not
    usable, i.e. the polygon is not monotone against it)."""
    n = len(points)
    o = corr[bstart]
    e = corr[bend]
    ex, ey = e[0] - o[0], e[1] - o[1]
    blen = math.hypot(ex, ey)
    if blen < 1e-9:
        return None
    ux, uy = ex / blen, ey / blen
    vx, vy = -uy, ux
    cen = (sum(p[0] for p in corr) / n, sum(p[1] for p in corr) / n)
    if (cen[0] - o[0]) * vx + (cen[1] - o[1]) * vy < 0:
        vx, vy = -vx, -vy
    along = [(corr[k][0] - o[0]) * ux + (corr[k][1] - o[1]) * uy for k in range(n)]
    offset = [(corr[k][0] - o[0]) * vx + (corr[k][1] - o[1]) * vy for k in range(n)]

    # A foot must not fall significantly BEFORE the baseline start: a negative "along" cannot be
    # measured as a positive distance from the start corner. A foot modestly PAST the far end is
    # fine — it is measured along the same wall line continued past the corner, and its true value
    # is requested (never clamped), so the polygon reconstruction stays exact.
    snap = 0.02 * blen          # a foot this close to an endpoint counts as AT that endpoint
    over_tol = 0.15 * blen      # how far past the far end a foot may sit and still be usable
    for k in range(n):
        if k in (bstart, bend):
            continue
        if along[k] < -snap or along[k] > blen + over_tol:
            return None

    def to_frac(cx: float, cy: float) -> Point:
        return {"x": cx / ar, "y": cy}

    base_id = f"m{edge}"
    items: List[dict] = [_item(base_id, f"Baseline wall {edge + 1} (measure along this)",
                               "side", points[bstart], points[bend], blen)]
    verts: List[list] = []
    for k in range(n):
        if k == bstart:
            verts.append([0.0, 0.0])
            continue
        if k == bend:
            verts.append([{"id": base_id}, 0.0])
            continue
        foot = (o[0] + along[k] * ux, o[1] + along[k] * uy)
        # x (position along the baseline): snap to an endpoint ONLY when the foot is essentially
        # there (so we never ask for a ~0 or ~baseline-length measurement). Otherwise request the
        # TRUE along distance — even a foot slightly past the far end — so no accuracy is lost to
        # clamping (clamping a past-the-end foot to the wall end was mislocating that corner).
        if along[k] <= snap:
            xsrc: object = 0.0
        elif abs(along[k] - blen) <= snap:
            xsrc = {"id": base_id}
        else:
            aid = f"a{k}"
            note = "Measure along the baseline wall from its start corner"
            note += (" (continue straight past the far corner to reach this point)."
                     if along[k] > blen else ".")
            items.append(_item(aid, f"Along baseline to corner {k + 1}", "side",
                               points[bstart], to_frac(*foot), along[k], note=note))
            xsrc = {"id": aid}
        oid = f"o{k}"
        items.append(_item(oid, f"Offset to corner {k + 1}", "offset",
                           to_frac(*foot), points[k], abs(offset[k]),
                           note="Measure square (perpendicular) out from the baseline wall."))
        verts.append([xsrc, {"id": oid}])
    return {"items": items, "recipe": {"method": "offsets", "verts": verts}}


def _build_orthogonal_plan(points: List[Point], aspect_ratio: float) -> Optional[dict]:
    """Right-angled room: request EVERY wall (one measurement per edge) and rebuild the
    polygon by walking the measured wall lengths, then take the area by the shoelace
    formula. Because a rectilinear polygon must close, the walk doubles as a built-in check
    for a mis-measured or mistyped wall (see perimeter_closure_gap). Every item is a real,
    measurable wall."""
    ar = aspect_ratio if aspect_ratio and aspect_ratio > 0 else 1.0
    n = len(points)
    if n < 4:
        return None
    corr = _corrected(points, ar)
    note = ("If a pillar or furniture blocks this wall, measure it in parts around the "
            "obstacle and enter the sum.")
    items: List[dict] = []
    edges: List[dict] = []
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        ca, cb = corr[i], corr[(i + 1) % n]
        dx, dy = cb[0] - ca[0], cb[1] - ca[1]
        if abs(dx) >= abs(dy):
            axis, sign, length = "x", (1 if dx > 0 else -1), abs(dx)
        else:
            axis, sign, length = "y", (1 if dy > 0 else -1), abs(dy)
        item_id = f"m{i}"
        items.append(_item(item_id, f"Wall {i + 1} ({_direction_label(a, b)})", "side",
                           a, b, length, note=note))
        edges.append({"id": item_id, "axis": axis, "sign": sign})
    recipe = {"method": "rectilinear_perimeter", "edges": edges}
    return {"items": items, "recipe": recipe}


def perimeter_closure_gap(recipe: Optional[dict], values: Dict[str, float]) -> Optional[float]:
    """For a rectilinear_perimeter recipe, how far the walked wall lengths miss closing the
    loop (in metres). A large gap means a wall was mis-measured. None if not applicable or
    the values are incomplete."""
    if not recipe or recipe.get("method") != "rectilinear_perimeter":
        return None
    x = y = 0.0
    for e in recipe["edges"]:
        try:
            L = float(values.get(e["id"]))
        except (TypeError, ValueError):
            return None
        if L <= 0:
            return None
        if e["axis"] == "x":
            x += e["sign"] * L
        else:
            y += e["sign"] * L
    return math.hypot(x, y)


# ── Area computation from measured values ──────────────────────────────────────
def compute_area(recipe: Optional[dict], values: Dict[str, float]) -> Optional[float]:
    """Evaluate the self-contained area recipe against measured values (metres).
    Returns area in m^2 at full precision (no premature rounding), or None if the
    required values are missing/invalid. The frontend must mirror this exactly."""
    if not recipe:
        return None

    def val(k: str) -> Optional[float]:
        v = values.get(k)
        try:
            v = float(v)
        except (TypeError, ValueError):
            return None
        return v if v > 0 else None

    method = recipe.get("method")

    if method == "product":
        a = val(recipe["items"][0])
        b = val(recipe["items"][1])
        return a * b if (a is not None and b is not None) else None

    if method == "heron":
        s = [val(k) for k in recipe["items"]]
        if any(x is None for x in s):
            return None
        return heron(s[0], s[1], s[2])

    if method == "trapezoid":
        a = val(recipe["a"])
        b = val(recipe["b"])
        h = val(recipe["h"])
        if a is None or b is None or h is None:
            return None
        return 0.5 * (a + b) * h

    if method == "heron_triangles":
        total = 0.0
        for tri in recipe["triangles"]:
            s = [val(k) for k in tri]
            if any(x is None for x in s):
                return None
            total += heron(s[0], s[1], s[2])
        return total

    if method == "sum_rectangles":
        total = 0.0
        for w_key, h_key in recipe["rects"]:
            w = val(w_key)
            h = val(h_key)
            if w is None or h is None:
                return None
            total += w * h
        return total

    if method == "rectilinear_perimeter":
        x = y = 0.0
        verts = [(0.0, 0.0)]
        for e in recipe["edges"]:
            L = val(e["id"])
            if L is None:
                return None
            if e["axis"] == "x":
                x += e["sign"] * L
            else:
                y += e["sign"] * L
            verts.append((x, y))
        ring = verts[:-1]
        m = len(ring)
        s = 0.0
        for i in range(m):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % m]
            s += x1 * y2 - x2 * y1
        return abs(s) / 2.0

    if method == "offsets":
        def resolve(src):
            if isinstance(src, dict):
                try:
                    v = float(values.get(src["id"]))
                except (TypeError, ValueError):
                    return None
                return v if v >= 0 else None
            try:
                return float(src)
            except (TypeError, ValueError):
                return None
        verts = []
        for xs, ys in recipe["verts"]:
            x = resolve(xs)
            y = resolve(ys)
            if x is None or y is None:
                return None
            verts.append((x, y))
        m = len(verts)
        s = 0.0
        for i in range(m):
            x1, y1 = verts[i]
            x2, y2 = verts[(i + 1) % m]
            s += x1 * y2 - x2 * y1
        return abs(s) / 2.0

    return None


def estimate_values(plan: dict, known: Optional[Dict[str, float]] = None) -> Dict[str, float]:
    """Best-effort hint values for the plan items. If the caller provides at least one
    known measured value, derive a single scale from it and scale the rest by relative
    lengths. Hints only, never used for the final area. Returns {} if no scale is known."""
    known = known or {}
    items = plan.get("items", [])
    scale = None
    for it in items:
        k = it["id"]
        if k in known and it.get("rel_len"):
            try:
                real = float(known[k])
            except (TypeError, ValueError):
                continue
            if real > 0 and it["rel_len"] > 0:
                scale = real / it["rel_len"]
                break
    if scale is None:
        return {}
    return {it["id"]: round(it["rel_len"] * scale, 3) for it in items if it.get("rel_len")}
