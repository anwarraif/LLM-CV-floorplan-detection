// Frontend mirror of backend geometry_service.compute_area (Phase 3).
//
// The BACKEND is the source of truth for area. This function must produce exactly the
// same result as backend/app/services/geometry_service.py compute_area, so the Measure
// page can show a live preview without a round trip per keystroke. Keep the two in sync.
//
// Area is computed from the values the stager actually measures (metres), via the
// self-contained recipe returned by POST /api/floorplan/measurement-plan.

// Mirrors the `kind` values emitted by geometry_service._item / _build_offset_plan.
// "offset" is a perpendicular distance out from a baseline wall and may legitimately be 0.
export type MeasurementKind = "side" | "diagonal" | "height" | "offset";

export interface MeasurementItem {
  id: string;
  label: string;
  kind: MeasurementKind;
  from: { x: number; y: number };
  to: { x: number; y: number };
  rel_len: number;
  required: boolean;
  feasible: boolean;
  note: string;
}

export interface AreaRecipe {
  method:
    | "product"
    | "heron"
    | "trapezoid"
    | "heron_triangles"
    | "sum_rectangles"
    | "rectilinear_perimeter"
    | "offsets";
  items?: string[];
  a?: string;
  b?: string;
  h?: string;
  triangles?: string[][];
  rects?: string[][];
  edges?: Array<{ id: string; axis: "x" | "y"; sign: number }>;
  verts?: Array<[number | { id: string }, number | { id: string }]>;
}

export interface MeasurementPlan {
  shape_class: string;
  supported: boolean;
  items: MeasurementItem[];
  recipe: AreaRecipe | null;
}

function heron(a: number, b: number, c: number): number {
  const s = (a + b + c) / 2;
  const v = s * (s - a) * (s - b) * (s - c);
  return v > 0 ? Math.sqrt(v) : 0;
}

/** Evaluate an area recipe against measured values (metres). Returns full-precision
 * area in m^2, or null if any required value is missing or not positive. Mirror of the
 * Python backend exactly. */
export function computeArea(
  recipe: AreaRecipe | null | undefined,
  values: Record<string, number | string>
): number | null {
  if (!recipe) return null;

  const val = (k: string): number | null => {
    const v = Number(values[k]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  switch (recipe.method) {
    case "product": {
      const a = val(recipe.items![0]);
      const b = val(recipe.items![1]);
      return a !== null && b !== null ? a * b : null;
    }
    case "heron": {
      const s = recipe.items!.map(val);
      if (s.some((x) => x === null)) return null;
      return heron(s[0]!, s[1]!, s[2]!);
    }
    case "trapezoid": {
      const a = val(recipe.a!);
      const b = val(recipe.b!);
      const h = val(recipe.h!);
      return a !== null && b !== null && h !== null ? 0.5 * (a + b) * h : null;
    }
    case "heron_triangles": {
      let total = 0;
      for (const tri of recipe.triangles!) {
        const s = tri.map(val);
        if (s.some((x) => x === null)) return null;
        total += heron(s[0]!, s[1]!, s[2]!);
      }
      return total;
    }
    case "sum_rectangles": {
      let total = 0;
      for (const [w, h] of recipe.rects!) {
        const wv = val(w);
        const hv = val(h);
        if (wv === null || hv === null) return null;
        total += wv * hv;
      }
      return total;
    }
    case "rectilinear_perimeter": {
      let x = 0, y = 0;
      const verts: Array<[number, number]> = [[0, 0]];
      for (const e of recipe.edges!) {
        const L = val(e.id);
        if (L === null) return null;
        if (e.axis === "x") x += e.sign * L;
        else y += e.sign * L;
        verts.push([x, y]);
      }
      const ring = verts.slice(0, -1);
      let s = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        s += x1 * y2 - x2 * y1;
      }
      return Math.abs(s) / 2;
    }
    case "offsets": {
      const resolve = (src: number | { id: string }): number | null => {
        if (typeof src === "object") {
          const v = Number(values[src.id]);
          return Number.isFinite(v) && v >= 0 ? v : null;
        }
        return typeof src === "number" ? src : null;
      };
      const verts: Array<[number, number]> = [];
      for (const [xs, ys] of recipe.verts!) {
        const x = resolve(xs);
        const y = resolve(ys);
        if (x === null || y === null) return null;
        verts.push([x, y]);
      }
      let s = 0;
      for (let i = 0; i < verts.length; i++) {
        const [x1, y1] = verts[i];
        const [x2, y2] = verts[(i + 1) % verts.length];
        s += x1 * y2 - x2 * y1;
      }
      return Math.abs(s) / 2;
    }
    default:
      return null;
  }
}

/** For a rectilinear_perimeter recipe, how far the walked wall lengths miss closing the
 * loop (metres). A large value means a wall was mis-measured. null if not applicable. */
export function closureGap(
  recipe: AreaRecipe | null | undefined,
  values: Record<string, number | string>
): number | null {
  if (!recipe || recipe.method !== "rectilinear_perimeter" || !recipe.edges) return null;
  let x = 0, y = 0;
  for (const e of recipe.edges) {
    const v = Number(values[e.id]);
    if (!Number.isFinite(v) || v <= 0) return null;
    if (e.axis === "x") x += e.sign * v;
    else y += e.sign * v;
  }
  return Math.hypot(x, y);
}

/** True when every required item has a measured value.
 *
 * A perpendicular OFFSET may legitimately be 0 — that is a corner sitting exactly on the
 * baseline wall — and compute_area accepts `>= 0` for offsets (geometry_service.py, the
 * `offsets` branch). Requiring `> 0` here made such a room impossible to complete. Every
 * other kind is a real distance and must be positive.
 *
 * A value must still be PRESENT: callers must not pass a key for an empty input, otherwise
 * a blank offset field would read as a deliberate 0. */
export function planComplete(
  plan: MeasurementPlan | null | undefined,
  values: Record<string, number | string>
): boolean {
  if (!plan || !plan.supported) return false;
  return plan.items
    .filter((it) => it.required)
    .every((it) => {
      const raw = values[it.id];
      if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return false;
      const v = Number(raw);
      if (!Number.isFinite(v)) return false;
      return it.kind === "offset" ? v >= 0 : v > 0;
    });
}

/** Reconstruct the room polygon vertices (measurement space, metres) from an `offsets`
 * recipe + measured values. Mirrors the reconstruction inside computeArea's "offsets" case.
 * Returns null if any value is missing (so callers only draw derived labels once complete). */
export function reconstructOffsetVertices(
  recipe: AreaRecipe | null | undefined,
  values: Record<string, number | string>
): Array<[number, number]> | null {
  if (!recipe || recipe.method !== "offsets" || !recipe.verts) return null;
  const resolve = (src: number | { id: string }): number | null => {
    if (typeof src === "object") {
      const v = Number(values[src.id]);
      return Number.isFinite(v) && v >= 0 ? v : null;
    }
    return typeof src === "number" ? src : null;
  };
  const verts: Array<[number, number]> = [];
  for (const [xs, ys] of recipe.verts) {
    const x = resolve(xs);
    const y = resolve(ys);
    if (x === null || y === null) return null;
    verts.push([x, y]);
  }
  return verts;
}

export interface WallLabel {
  x: number;        // wall midpoint, image fraction (0..1)
  y: number;
  len: number;      // derived wall length in metres
  baseline: boolean; // true for the measured baseline wall (already shows its input value)
}

/** For an `offsets` room, the DERIVED length of every wall (polygon edge), with the
 * wall's midpoint in image-fraction space so the canvas can label it. Length comes from
 * the measured values (reconstruction); the display position comes from the plan items'
 * endpoints (the baseline item's from/to and each offset item's `to`). Returns null until
 * every value is entered. Non-offset plans return null (their walls are measured directly). */
export function offsetWallLabels(
  plan: MeasurementPlan | null | undefined,
  values: Record<string, number | string>
): WallLabel[] | null {
  if (!plan || !plan.recipe || plan.recipe.method !== "offsets" || !plan.recipe.verts) return null;
  const mverts = reconstructOffsetVertices(plan.recipe, values);
  if (!mverts) return null;
  const base = plan.items[0]; // baseline is always the first item for an offsets plan
  if (!base) return null;
  // display position (fraction) of each recipe vertex
  const disp: Array<{ x: number; y: number } | null> = plan.recipe.verts.map(([xs, ys]) => {
    if (typeof ys === "number") {
      return typeof xs === "number" ? base.from : base.to; // bstart : bend
    }
    const item = plan.items.find((it) => it.id === ys.id);
    return item ? item.to : null;
  });
  if (disp.some((d) => d === null)) return null;
  const n = mverts.length;
  const out: WallLabel[] = [];
  for (let i = 0; i < n; i++) {
    const a = mverts[i];
    const b = mverts[(i + 1) % n];
    const da = disp[i]!;
    const db = disp[(i + 1) % n]!;
    const baseline =
      typeof plan.recipe.verts[i][1] === "number" &&
      typeof plan.recipe.verts[(i + 1) % n][1] === "number";
    out.push({
      x: (da.x + db.x) / 2,
      y: (da.y + db.y) / 2,
      len: Math.hypot(b[0] - a[0], b[1] - a[1]),
      baseline,
    });
  }
  return out;
}
