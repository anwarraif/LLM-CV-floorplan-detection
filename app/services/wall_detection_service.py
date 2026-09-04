"""
Detect room areas from floor plan walls using OpenCV.
Does NOT rely on text labels -- detects from wall geometry only.
Works for all floor plan types: rectangular, diagonal, hand-drawn, digital.
"""

import cv2
import numpy as np
from typing import List, Dict


def preprocess_floor_plan(img: np.ndarray) -> np.ndarray:
    """Multi-step preprocessing that captures thin internal walls."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Otsu threshold — reliable for high-contrast walls
    _, thresh_otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Adaptive threshold with small block size — catches thin walls
    adaptive = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        blockSize=7, C=3,
    )

    combined = cv2.bitwise_or(thresh_otsu, adaptive)

    # Gradient-based edge detection — finds wall edges missed by threshold
    gradient = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, np.ones((2, 2), np.uint8))
    _, grad_thresh = cv2.threshold(gradient, 15, 255, cv2.THRESH_BINARY)
    combined = cv2.bitwise_or(combined, grad_thresh)

    # Close small gaps with smaller kernel to avoid merging thin walls
    kernel = np.ones((2, 2), np.uint8)
    return cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel, iterations=2)


def detect_closed_areas(image_path: str) -> Dict:
    """
    Detect room regions from floor plan using wall contour detection.
    Uses RETR_CCOMP to find both wall outlines and the room holes inside them.
    Works for axis-aligned and diagonal floor plans.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"regions": [], "error": "Cannot read image"}

    h, w = img.shape[:2]
    thresh_clean = preprocess_floor_plan(img)

    # RETR_CCOMP: two-level hierarchy — level-1 = wall outlines, level-2 = room holes
    contours, _ = cv2.findContours(
        thresh_clean, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE
    )

    min_area = (w * h) * 0.005   # 0.5% minimum
    max_area = (w * h) * 0.15    # 15% maximum — filters full floor-plan outline

    regions = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area:
            continue

        perimeter = cv2.arcLength(cnt, True)
        best_approx = None
        for eps in [0.008, 0.01, 0.015, 0.02, 0.025]:
            approx = cv2.approxPolyDP(cnt, eps * perimeter, True)
            if 4 <= len(approx) <= 16:
                best_approx = approx
                break

        if best_approx is None:
            continue

        polygon_points = [
            {"x": round(float(p[0][0]) / w, 4), "y": round(float(p[0][1]) / h, 4)}
            for p in best_approx
        ]

        rx, ry, rw, rh = cv2.boundingRect(cnt)
        bbox = {
            "x": round(float(rx) / w, 4),
            "y": round(float(ry) / h, 4),
            "w": round(float(rw) / w, 4),
            "h": round(float(rh) / h, 4),
        }

        M = cv2.moments(cnt)
        if M["m00"] != 0:
            cx = round(float(M["m10"] / M["m00"]) / w, 4)
            cy = round(float(M["m01"] / M["m00"]) / h, 4)
        else:
            cx = bbox["x"] + bbox["w"] / 2
            cy = bbox["y"] + bbox["h"] / 2

        n = len(best_approx)
        if n == 4:
            pts = [(float(p[0][0]), float(p[0][1])) for p in best_approx]
            is_axis = all(
                abs(pts[i][0] - pts[(i + 1) % 4][0]) < w * 0.02
                or abs(pts[i][1] - pts[(i + 1) % 4][1]) < h * 0.02
                for i in range(4)
            )
            shape_type = "rectangle" if is_axis else "rotated"
        else:
            shape_type = "polygon"

        regions.append({
            "polygon_points": polygon_points,
            "bbox": bbox,
            "centroid": {"x": cx, "y": cy},
            "area_fraction": round(area / (w * h), 4),
            "shape_type": shape_type,
            "num_vertices": n,
        })

    regions.sort(key=lambda r: r["area_fraction"], reverse=True)

    # Remove near-duplicate regions (centroids within 4%)
    deduped = []
    for region in regions:
        is_dup = False
        for existing in deduped:
            dx = abs(region["centroid"]["x"] - existing["centroid"]["x"])
            dy = abs(region["centroid"]["y"] - existing["centroid"]["y"])
            if dx < 0.04 and dy < 0.04:
                is_dup = True
                break
        if not is_dup:
            deduped.append(region)

    return {
        "regions": deduped[:20],
        "total_found": len(regions),
        "image_size": {"width": w, "height": h},
    }


def detect_rooms_ftb_approach(image_path: str, orientation: str = "axis-aligned") -> Dict:
    """
    Room detection based on FloorplanToBlender3d algorithm.
    Fixed parameters -- no per-image tuning.
    Fast: < 1 second per image.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"regions": [], "error": "Cannot read image"}

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Step 1: wall_filter -- exact from FTB
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    kernel = np.ones((3, 3), np.uint8)
    opening = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=2)
    sure_bg = cv2.dilate(opening, kernel, iterations=2)

    dist_transform = cv2.distanceTransform(opening, cv2.DIST_L2, 5)
    if dist_transform.max() == 0:
        return {"regions": [], "total_found": 0}

    _, sure_fg = cv2.threshold(
        0.5 * dist_transform,
        0.5 * dist_transform.max(),
        255, cv2.THRESH_BINARY
    )
    sure_fg = np.uint8(sure_fg)
    walls = cv2.subtract(sure_bg, sure_fg)

    # Step 2: remove_noise -- remove small blobs
    noise_threshold = int((w * h) * 0.0005)
    num_labels, labels_im = cv2.connectedComponents(walls)
    cleaned = np.zeros_like(walls)
    for lab in range(1, num_labels):
        comp = labels_im == lab
        if np.count_nonzero(comp) >= noise_threshold:
            cleaned[comp] = 255

    # Step 3: invert -- rooms are white
    img_rooms = ~cleaned

    # Step 4: corners_and_draw_lines -- FTB approach with extended closing distance.
    # Real floor plans: doorways are ~17-25px wide; use 8% of min dimension to seal them.
    # Axis-aligned only: H/V corner connections are safe (won't cross room interiors).
    corners_threshold = 0.01
    room_closing_max_length = int(min(w, h) * 0.08)

    walls_float = np.float32(cleaned)
    dst = cv2.cornerHarris(walls_float, blockSize=5, ksize=3, k=0.04)
    dst = cv2.erode(dst, kernel, iterations=1)
    corners = dst > corners_threshold * dst.max()

    # Connect corners on same Y (horizontal lines) -- FTB original
    for y, row in enumerate(corners):
        x_same_y = np.argwhere(row)
        for x1, x2 in zip(x_same_y[:-1], x_same_y[1:]):
            if x2[0] - x1[0] < room_closing_max_length:
                cv2.line(img_rooms, (int(x1[0]), y), (int(x2[0]), y), 0, 1)

    # Connect corners on same X (vertical lines) -- FTB original
    for x, col in enumerate(corners.T):
        y_same_x = np.argwhere(col)
        for y1, y2 in zip(y_same_x[:-1], y_same_x[1:]):
            if y2[0] - y1[0] < room_closing_max_length:
                cv2.line(img_rooms, (x, int(y1[0])), (x, int(y2[0])), 0, 1)

    # EXTENSION for diagonal floor plans -- connect diagonal corners too
    if orientation in ("diagonal", "mixed"):
        num_labels, labels_im, stats, centroids = cv2.connectedComponentsWithStats(np.uint8(corners))
        corner_points = centroids[1:]
        for i in range(len(corner_points)):
            for j in range(i + 1, len(corner_points)):
                x1, y1 = corner_points[i]
                x2, y2 = corner_points[j]
                dx = abs(x1 - x2)
                dy = abs(y1 - y2)
                dist = (dx ** 2 + dy ** 2) ** 0.5
                if dist < room_closing_max_length:
                    if abs(dx - dy) < room_closing_max_length * 0.4:
                        cv2.line(img_rooms, (int(x1), int(y1)), (int(x2), int(y2)), 0, 1)

    # Step 5: Remove exterior.
    # FTB flood-fills from border, but real floor plans sit on white canvas — flood
    # bleeds through open doorways into every room. Instead: remove the largest CC
    # (which is always the exterior + anything connected to it through doorway gaps).
    # Remaining CCs are fully-enclosed room interiors that survived sealing.
    num_pre, labels_pre = cv2.connectedComponents(img_rooms)
    if num_pre > 1:
        sizes = [(int(np.count_nonzero(labels_pre == lbl)), lbl)
                 for lbl in range(1, num_pre)]
        exterior_lbl = max(sizes, key=lambda s: s[0])[1]
        img_rooms[labels_pre == exterior_lbl] = 0

    # Step 6: connectedComponents -- FTB approach
    gap_min = int((w * h) * 0.003)
    gap_max = int((w * h) * 0.70)

    num_labels, labels = cv2.connectedComponents(img_rooms)

    regions = []
    for label in range(1, num_labels):
        component = (labels == label).astype(np.uint8) * 255
        pixel_count = np.count_nonzero(component)

        if pixel_count < gap_min or pixel_count > gap_max:
            continue

        contours, _ = cv2.findContours(
            component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            continue

        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        if perimeter == 0:
            continue

        best_approx = None
        for eps in [0.008, 0.01, 0.015, 0.02]:
            approx = cv2.approxPolyDP(largest, eps * perimeter, True)
            if 3 <= len(approx) <= 16:
                best_approx = approx
                break
        if best_approx is None:
            continue

        points = [
            {"x": round(float(p[0][0]) / w, 4),
             "y": round(float(p[0][1]) / h, 4)}
            for p in best_approx
        ]

        x_c, y_c, rw, rh = cv2.boundingRect(largest)
        bbox = {
            "x": round(float(x_c) / w, 4),
            "y": round(float(y_c) / h, 4),
            "w": round(float(rw) / w, 4),
            "h": round(float(rh) / h, 4),
        }

        M = cv2.moments(largest)
        if M["m00"] != 0:
            cx = round(float(M["m10"] / M["m00"]) / w, 4)
            cy = round(float(M["m01"] / M["m00"]) / h, 4)
        else:
            cx = bbox["x"] + bbox["w"] / 2
            cy = bbox["y"] + bbox["h"] / 2

        n = len(best_approx)
        pts_list = [(float(p[0][0]), float(p[0][1])) for p in best_approx]
        if n == 4:
            is_axis = all(
                abs(pts_list[i][0] - pts_list[(i + 1) % 4][0]) < w * 0.02
                or abs(pts_list[i][1] - pts_list[(i + 1) % 4][1]) < h * 0.02
                for i in range(4)
            )
            shape_type = "rectangle" if is_axis else "rotated"
        else:
            shape_type = "polygon"

        regions.append({
            "polygon_points": points,
            "bbox": bbox,
            "centroid": {"x": cx, "y": cy},
            "area_fraction": round(pixel_count / (w * h), 4),
            "shape_type": shape_type,
            "num_vertices": n,
        })

    regions.sort(key=lambda r: r["area_fraction"], reverse=True)

    deduped: List[Dict] = []
    for region in regions:
        is_dup = any(
            abs(region["centroid"]["x"] - e["centroid"]["x"]) < 0.04
            and abs(region["centroid"]["y"] - e["centroid"]["y"]) < 0.04
            for e in deduped
        )
        if not is_dup:
            deduped.append(region)

    return {
        "regions": deduped[:20],
        "total_found": len(regions),
        "image_size": {"width": w, "height": h},
    }


def detect_rooms_watershed(image_path: str, seed_centroids: list) -> list:
    """
    Watershed room detection seeded from GPT-provided centroids.

    Topography: distance transform from walls — room centers are valleys (low cost),
    walls and exterior are peaks (high cost, stop growth). Convex hull of wall pixels
    defines the floor plan boundary; growth is blocked outside it.

    Args:
        image_path: path to floor plan image
        seed_centroids: list of {room_name, x, y} normalized centroids from GPT

    Returns:
        list of rooms with accurate polygon_points
    """
    img = cv2.imread(image_path)
    if img is None:
        return []

    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Step 1: Wall mask — dark thick lines, filtered to remove text labels/noise
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    
    # Filter out small components (noise, room labels, text)
    num_labels, labels_im, stats, _ = cv2.connectedComponentsWithStats(thresh, connectivity=8)
    cleaned_walls = np.zeros_like(thresh)
    
    # A component must have an area of at least 0.03% of the image size (or min 100px)
    min_wall_area = max(100, int((w * h) * 0.0003))
    for lab in range(1, num_labels):
        area = stats[lab, cv2.CC_STAT_AREA]
        if area >= min_wall_area:
            cleaned_walls[labels_im == lab] = 255

    # Close doorways by connecting nearby wall corners (doorway sealing)
    room_closing_max_length = max(15, min(35, int(min(w, h) * 0.05)))
    corners_threshold = 0.01
    walls_float = np.float32(cleaned_walls)
    dst = cv2.cornerHarris(walls_float, blockSize=5, ksize=3, k=0.04)
    dst = cv2.erode(dst, np.ones((2, 2), np.uint8), iterations=1)
    corners = dst > corners_threshold * dst.max()
    
    num_labels, labels_im, stats, centroids = cv2.connectedComponentsWithStats(np.uint8(corners))
    corner_points = centroids[1:]
    for i in range(len(corner_points)):
        for j in range(i + 1, len(corner_points)):
            x1, y1 = corner_points[i]
            x2, y2 = corner_points[j]
            dx = x1 - x2
            dy = y1 - y2
            dist = (dx ** 2 + dy ** 2) ** 0.5
            if dist < room_closing_max_length:
                cv2.line(cleaned_walls, (int(x1), int(y1)), (int(x2), int(y2)), 255, 2)

    kernel = np.ones((2, 2), np.uint8)
    walls_mask = cv2.dilate(cleaned_walls, kernel, iterations=1)

    # Step 2: Floor plan boundary — two-method approach, best result wins.
    # Method A: threshold near-white pixels (>200) = exterior canvas; invert to get floor plan.
    # Works well when floor plan sits on a white canvas (most rendered floor plans).
    _, thresh_outer = cv2.threshold(blur, 200, 255, cv2.THRESH_BINARY_INV)
    fp_contours_a, _ = cv2.findContours(thresh_outer, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Method B: dilate walls heavily so the floor plan becomes one solid blob.
    # Works when exterior is not purely white (colored, aged scans).
    close_px = max(20, int(min(w, h) * 0.03))
    close_k = np.ones((close_px, close_px), np.uint8)
    walls_closed = cv2.dilate(walls_mask, close_k, iterations=2)
    fp_contours_b, _ = cv2.findContours(walls_closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    def _largest_contour_area(contours):
        return cv2.contourArea(max(contours, key=cv2.contourArea)) if contours else 0

    # Prefer Method A if it produces a large enough region (>5% of image)
    area_a = _largest_contour_area(fp_contours_a)
    area_b = _largest_contour_area(fp_contours_b)
    if area_a > (w * h) * 0.05 and area_a >= area_b * 0.5:
        fp_contour = max(fp_contours_a, key=cv2.contourArea)
    elif fp_contours_b:
        fp_contour = max(fp_contours_b, key=cv2.contourArea)
    else:
        return []

    fp_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(fp_mask, [fp_contour], 255)
    # Erode slightly so watershed doesn't bleed along the boundary edge
    fp_mask = cv2.erode(fp_mask, np.ones((5, 5), np.uint8), iterations=2)

    # Step 3: Watershed topography via distance transform.
    # Interior pixels far from walls = low cost (easy to grow through).
    # Pixels near walls or outside floor plan = high cost (hard to cross).
    interior = np.zeros((h, w), dtype=np.uint8)
    interior[(fp_mask > 0) & (walls_mask == 0)] = 255
    dt = cv2.distanceTransform(interior, cv2.DIST_L2, 5)

    # Invert DT: room centers (high DT) → 0; walls/exterior (low DT) → 255
    if dt.max() > 0:
        ws_input = np.uint8(255 - np.clip(255.0 * dt / dt.max(), 0, 255))
    else:
        ws_input = np.full((h, w), 255, dtype=np.uint8)
    ws_input[walls_mask > 0] = 255   # hard wall barrier
    ws_input[fp_mask == 0] = 255     # hard exterior barrier

    # Step 4: Seed markers
    markers = np.zeros((h, w), dtype=np.int32)
    markers[fp_mask == 0] = 1  # label 1 = exterior/background

    valid_seeds = []
    for i, seed in enumerate(seed_centroids):
        px = max(1, min(w - 2, int(seed["x"] * w)))
        py = max(1, min(h - 2, int(seed["y"] * h)))

        # Move seed off wall or exterior
        if walls_mask[py, px] > 0 or fp_mask[py, px] == 0:
            found = False
            for radius in [3, 6, 10, 15]:
                for ddy in range(-radius, radius + 1):
                    for ddx in range(-radius, radius + 1):
                        nx, ny = px + ddx, py + ddy
                        if 0 <= nx < w and 0 <= ny < h:
                            if walls_mask[ny, nx] == 0 and fp_mask[ny, nx] > 0:
                                px, py = nx, ny
                                found = True
                                break
                    if found:
                        break
                if found:
                    break

        label = i + 2
        markers[max(0, py - 1):py + 2, max(0, px - 1):px + 2] = label
        valid_seeds.append({**seed, "label": label})

    # Step 5: Run watershed
    ws_bgr = cv2.cvtColor(ws_input, cv2.COLOR_GRAY2BGR)
    cv2.watershed(ws_bgr, markers)

    _OPEN_PLAN_KEYWORDS = {"living", "dining", "lounge", "open", "studio"}

    def _is_open_plan(room_name: str) -> bool:
        name_lower = room_name.lower()
        return any(k in name_lower for k in _OPEN_PLAN_KEYWORDS)

    def _ai_fallback(seed: dict) -> dict:
        bbox = seed.get("bbox") or {}
        existing_pts = seed.get("polygon_points") or []
        if bbox and bbox.get("w", 0) > 0:
            x_b, y_b, bw, bh = bbox["x"], bbox["y"], bbox["w"], bbox["h"]
            fallback_pts = existing_pts or [
                {"x": x_b, "y": y_b},
                {"x": x_b + bw, "y": y_b},
                {"x": x_b + bw, "y": y_b + bh},
                {"x": x_b, "y": y_b + bh},
            ]
            return {
                "room_name": seed["room_name"],
                "polygon_points": fallback_pts,
                "bbox": bbox,
                "centroid": {"x": round(x_b + bw / 2, 4), "y": round(y_b + bh / 2, 4)},
                "area_fraction": round(bw * bh, 4),
                "shape_type": seed.get("shape_type", "rectangle"),
                "num_vertices": len(fallback_pts),
                "confidence": seed.get("confidence", 0.9),
                "source": "ai_fallback",
            }
        return None

    # Step 6: Extract polygon per room, with open-plan and quality fallback
    results = []
    for seed in valid_seeds:
        room_name = seed["room_name"]

        # Open-plan rooms & Balconies/Exterior: watershed bleeds through doorways/open areas — use GPT polygon directly
        is_balcony = seed.get("is_balcony", False) or any(k in room_name.lower() for k in ["balcony", "deck", "terrace", "porch"])
        if _is_open_plan(room_name) or is_balcony:
            fb = _ai_fallback(seed)
            if fb:
                results.append(fb)
            continue

        label = seed["label"]
        room_mask = (markers == label).astype(np.uint8) * 255
        # Constrain to floor plan boundary — prevents bleeding into exterior canvas
        room_mask = cv2.bitwise_and(room_mask, fp_mask)
        pixel_count = int(np.count_nonzero(room_mask))

        # Too small — seed probably landed outside floor plan
        if pixel_count < (w * h) * 0.003:
            fb = _ai_fallback(seed)
            if fb:
                results.append(fb)
            continue

        contours, _ = cv2.findContours(
            room_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            fb = _ai_fallback(seed)
            if fb:
                results.append(fb)
            continue

        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        if perimeter == 0:
            fb = _ai_fallback(seed)
            if fb:
                results.append(fb)
            continue

        best_approx = None
        for eps in [0.008, 0.01, 0.015, 0.02]:
            approx = cv2.approxPolyDP(largest, eps * perimeter, True)
            if 3 <= len(approx) <= 20:
                best_approx = approx
                break
        if best_approx is None:
            fb = _ai_fallback(seed)
            if fb:
                results.append(fb)
            continue

        points = [
            {"x": round(float(p[0][0]) / w, 4),
             "y": round(float(p[0][1]) / h, 4)}
            for p in best_approx
        ]

        xs = [p["x"] for p in points]
        ys = [p["y"] for p in points]
        bbox = {
            "x": round(min(xs), 4), "y": round(min(ys), 4),
            "w": round(max(xs) - min(xs), 4), "h": round(max(ys) - min(ys), 4),
        }

        M = cv2.moments(largest)
        if M["m00"] != 0:
            cx = round(float(M["m10"] / M["m00"]) / w, 4)
            cy = round(float(M["m01"] / M["m00"]) / h, 4)
        else:
            cx = bbox["x"] + bbox["w"] / 2
            cy = bbox["y"] + bbox["h"] / 2

        # Quality gate: watershed centroid must be within 0.20 of seed
        dist = ((cx - seed["x"]) ** 2 + (cy - seed["y"]) ** 2) ** 0.5
        if dist > 0.20:
            fb = _ai_fallback(seed)
            if fb:
                results.append(fb)
            continue

        n = len(best_approx)
        if n == 4:
            pts_l = [(float(p[0][0]), float(p[0][1])) for p in best_approx]
            is_axis = all(
                abs(pts_l[i][0] - pts_l[(i + 1) % 4][0]) < w * 0.02
                or abs(pts_l[i][1] - pts_l[(i + 1) % 4][1]) < h * 0.02
                for i in range(4)
            )
            shape_type = "rectangle" if is_axis else "rotated"
        else:
            shape_type = "polygon"

        results.append({
            "room_name": room_name,
            "polygon_points": points,
            "bbox": bbox,
            "centroid": {"x": cx, "y": cy},
            "area_fraction": round(pixel_count / (w * h), 4),
            "shape_type": shape_type,
            "num_vertices": n,
            "confidence": seed.get("confidence", 0.9),
            "source": "watershed",
        })

    return results


def detect_rotation_angle(img: np.ndarray) -> float:
    """Detect dominant wall angle via weighted Hough lines.
    Returns deskew angle in degrees (for cv2.getRotationMatrix2D) so walls align to axis.
    Returns 0.0 if walls are already axis-aligned (< 5° off).
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=50,
                             minLineLength=30, maxLineGap=10)
    if lines is None or len(lines) < 5:
        return 0.0

    angles: List[float] = []
    weights: List[float] = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        length = float(np.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2))
        if length < 20:
            continue
        a = float(abs(np.degrees(np.arctan2(y2 - y1, x2 - x1))))
        if a > 90:
            a = 180 - a   # fold to [0, 90]
        angles.append(a)
        weights.append(length)

    if not angles:
        return 0.0

    bins = np.arange(0, 91, 3)
    hist, bin_edges = np.histogram(angles, bins=bins, weights=weights)
    peak = int(np.argmax(hist))
    dominant = float((bin_edges[peak] + bin_edges[peak + 1]) / 2)

    # Already axis-aligned — no rotation needed
    if dominant < 5 or dominant > 85:
        return 0.0

    # Return minimum rotation to make walls axis-aligned
    if dominant <= 45:
        return -dominant          # rotate CW (negative in cv2) to align to horizontal
    else:
        return float(90 - dominant)  # rotate CCW (positive in cv2) to align to vertical


def detect_with_rotation(image_path: str) -> Dict:
    """
    For diagonal floor plans: rotate image to straighten walls, run detect_closed_areas,
    then inverse-transform all polygon points/centroids/bboxes back to original coords.
    Falls back to detect_closed_areas without rotation if angle < 3° or image unreadable.
    """
    import os
    import tempfile

    img = cv2.imread(image_path)
    if img is None:
        return {"regions": [], "error": "Cannot read image"}

    h, w = img.shape[:2]
    angle = detect_rotation_angle(img)
    print(f"[CV-rotation] {os.path.basename(image_path)}: dominant wall angle → deskew {angle:.1f}°")

    if abs(angle) < 3:
        result = detect_closed_areas(image_path)
        result["rotation_angle"] = 0.0
        return result

    # Build rotation matrix centred on image
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)

    # Expand canvas to fit full rotated image (no clipping)
    cos_a = abs(M[0, 0])
    sin_a = abs(M[0, 1])
    new_w = int(h * sin_a + w * cos_a)
    new_h = int(h * cos_a + w * sin_a)
    M[0, 2] += (new_w - w) / 2.0
    M[1, 2] += (new_h - h) / 2.0

    rotated = cv2.warpAffine(img, M, (new_w, new_h), borderValue=(255, 255, 255))

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
    cv2.imwrite(tmp_path, rotated)

    try:
        rot_result = detect_closed_areas(tmp_path)
    finally:
        os.unlink(tmp_path)

    # Precompute inverse transform
    M_inv = cv2.invertAffineTransform(M)

    def _inv(fx: float, fy: float):
        """Map fraction in rotated image → fraction in original image."""
        rx, ry = fx * new_w, fy * new_h
        ox = M_inv[0, 0] * rx + M_inv[0, 1] * ry + M_inv[0, 2]
        oy = M_inv[1, 0] * rx + M_inv[1, 1] * ry + M_inv[1, 2]
        return round(max(0.0, min(1.0, ox / w)), 4), round(max(0.0, min(1.0, oy / h)), 4)

    for region in rot_result.get("regions", []):
        # Transform polygon points
        region["polygon_points"] = [
            {"x": px, "y": py}
            for pt in region["polygon_points"]
            for px, py in [_inv(pt["x"], pt["y"])]
        ]
        # Transform centroid
        cx_t, cy_t = _inv(region["centroid"]["x"], region["centroid"]["y"])
        region["centroid"] = {"x": cx_t, "y": cy_t}
        # Transform bbox via its four corners then recompute axis-aligned bbox
        b = region["bbox"]
        corners = [
            (b["x"], b["y"]), (b["x"] + b["w"], b["y"]),
            (b["x"] + b["w"], b["y"] + b["h"]), (b["x"], b["y"] + b["h"]),
        ]
        tpts = [_inv(cx_r, cy_r) for cx_r, cy_r in corners]
        xs_t = [p[0] for p in tpts]
        ys_t = [p[1] for p in tpts]
        region["bbox"] = {
            "x": round(min(xs_t), 4), "y": round(min(ys_t), 4),
            "w": round(max(xs_t) - min(xs_t), 4),
            "h": round(max(ys_t) - min(ys_t), 4),
        }

    rot_result["rotation_angle"] = angle
    return rot_result


def match_rooms_to_regions(ai_rooms: List[Dict], cv_regions: List[Dict]) -> List[Dict]:
    """Match AI room names to CV detected regions using centroid + area proximity."""
    if not cv_regions:
        return ai_rooms

    matched = []
    used = set()

    for room in ai_rooms:
        bbox = room.get("bbox") or {}
        if not bbox or not bbox.get("w"):
            matched.append(room)
            continue

        ai_cx = bbox["x"] + bbox["w"] / 2
        ai_cy = bbox["y"] + bbox["h"] / 2
        ai_area = bbox["w"] * bbox["h"]

        best_idx = -1
        best_score = float("inf")

        for idx, region in enumerate(cv_regions):
            if idx in used:
                continue
            cv_cx = region["centroid"]["x"]
            cv_cy = region["centroid"]["y"]
            dist = ((ai_cx - cv_cx) ** 2 + (ai_cy - cv_cy) ** 2) ** 0.5
            if dist >= 0.15:
                continue
            # Skip regions with very different area from AI bbox (symmetric ratio)
            cv_area = region["area_fraction"]
            if ai_area > 0 and cv_area > 0:
                area_ratio = max(ai_area, cv_area) / min(ai_area, cv_area)
                if area_ratio > 2.5:
                    continue
            area_diff = abs(ai_area - region["area_fraction"])
            score = dist * 2 + area_diff
            if score < best_score:
                best_score = score
                best_idx = idx

        if best_idx >= 0:
            used.add(best_idx)
            r = dict(room)
            r["polygon_points"] = cv_regions[best_idx]["polygon_points"]
            r["bbox"] = cv_regions[best_idx]["bbox"]
            r["shape_type"] = cv_regions[best_idx]["shape_type"]
            matched.append(r)
        else:
            matched.append(room)

    return matched
