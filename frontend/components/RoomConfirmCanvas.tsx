"use client";

import { useRef, useEffect, useCallback, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

function buildImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = API_URL.replace(/\/$/, "");
  const path = url.startsWith("/") ? url : "/" + url;
  return base + path;
}

export type DrawMode = "rectangle" | "rotated" | "polygon";

export type RoomShape = {
  mode: DrawMode;
  rotatedRect?: { cx: number; cy: number; w: number; h: number; angle: number };
  polygonPoints?: Array<{ x: number; y: number }>;
};

type BBox = { x: number; y: number; w: number; h: number };

export type ConfirmRoom = {
  room_name: string;
  is_balcony: boolean;
  bbox: BBox | null;
  confidence?: number;
  source?: "ai" | "user_marked" | "user_added";
  shape?: RoomShape;
  polygon_points?: Array<{ x: number; y: number }>;
};

interface Props {
  imageUrl: string;
  allRooms: ConfirmRoom[];
  currentRoomIndex: number;
  adjustMode: boolean;
  onShapeDrawn: (bbox: BBox, shape?: RoomShape) => void;
}

// ── Rotated-rect helpers ──────────────────────────────────────────────────────
function rotatePoint(px: number, py: number, angle: number) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: px * cos - py * sin, y: px * sin + py * cos };
}

function getRotatedCornersPx(
  rr: { x1: number; y1: number; x2: number; y2: number },
  angle: number,
  W: number,
  H: number,
) {
  const rcx = (rr.x1 + rr.x2) / 2 * W, rcy = (rr.y1 + rr.y2) / 2 * H;
  const rw  = Math.abs(rr.x2 - rr.x1) * W, rh = Math.abs(rr.y2 - rr.y1) * H;
  return [
    { x: -rw / 2, y: -rh / 2 }, { x: rw / 2, y: -rh / 2 },
    { x: rw / 2, y:  rh / 2 }, { x: -rw / 2, y:  rh / 2 },
  ].map((c) => { const r = rotatePoint(c.x, c.y, angle); return { x: rcx + r.x, y: rcy + r.y }; });
}

function resizeRotatedCorner(
  rr: { x1: number; y1: number; x2: number; y2: number },
  angle: number,
  corner: "tl" | "tr" | "br" | "bl",
  newX: number,
  newY: number,
  W: number,
  H: number,
) {
  const rcx = (rr.x1 + rr.x2) / 2 * W, rcy = (rr.y1 + rr.y2) / 2 * H;
  const rw  = Math.abs(rr.x2 - rr.x1) * W, rh = Math.abs(rr.y2 - rr.y1) * H;
  const oppLocal = { tl: { x: rw / 2, y: rh / 2 }, tr: { x: -rw / 2, y: rh / 2 }, br: { x: -rw / 2, y: -rh / 2 }, bl: { x: rw / 2, y: -rh / 2 } }[corner];
  const newLocal = rotatePoint(newX - rcx, newY - rcy, -angle);
  const newCenterLocal = { x: (newLocal.x + oppLocal.x) / 2, y: (newLocal.y + oppLocal.y) / 2 };
  const r = rotatePoint(newCenterLocal.x, newCenterLocal.y, angle);
  const newCenter = { x: rcx + r.x, y: rcy + r.y };
  const newRw = Math.max(0.01 * W, Math.abs(newLocal.x - oppLocal.x));
  const newRh = Math.max(0.01 * H, Math.abs(newLocal.y - oppLocal.y));
  return {
    x1: (newCenter.x - newRw / 2) / W, y1: (newCenter.y - newRh / 2) / H,
    x2: (newCenter.x + newRw / 2) / W, y2: (newCenter.y + newRh / 2) / H,
  };
}

function isValidPolygon(pts: Array<{ x: number; y: number }>, W: number, H: number): boolean {
  if (pts.length < 3) return false;
  const xs = pts.map((p) => p.x * W);
  const ys = pts.map((p) => p.y * H);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return spanX >= 10 || spanY >= 10;
}

function getPolygonCentroid(pts: Array<{ x: number; y: number }>) {
  if (pts.length < 3) {
    return {
      x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
      y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
    };
  }
  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const factor = p1.x * p2.y - p2.x * p1.y;
    area += factor;
    cx += (p1.x + p2.x) * factor;
    cy += (p1.y + p2.y) * factor;
  }

  area = area / 2;
  if (Math.abs(area) < 1e-7) {
    return {
      x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
      y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
    };
  }

  cx = cx / (6 * area);
  cy = cy / (6 * area);
  return { x: cx, y: cy };
}

function getDistanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return { dist: Math.sqrt((px - x1)**2 + (py - y1)**2), x: x1, y: y1 };
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return {
    dist: Math.sqrt((px - projX)**2 + (py - projY)**2),
    x: projX,
    y: projY,
    t: t
  };
}

// ── "Straighten to right angles" helpers (Review one-click cleanup) ────────────
// Frontend-only, user-initiated, previewed & reversible; does NOT touch the area engine.
// Mirrors the backend's rectilinearize/cluster-snap/drop-collinear, but applied
// unconditionally on demand. A degeneracy guard refuses genuinely angled shapes.
type Pt = { x: number; y: number };

function rectilinearizePoly(pts: Pt[], ar: number, iters = 14): Pt[] {
  const n = pts.length;
  const out = pts.map((p) => ({ ...p }));
  const orient: ("H" | "V")[] = [];
  for (let i = 0; i < n; i++) {
    const a = out[i], b = out[(i + 1) % n];
    orient.push(Math.abs((b.x - a.x) * ar) >= Math.abs(b.y - a.y) ? "H" : "V");
  }
  for (let t = 0; t < iters; t++) {
    for (let i = 0; i < n; i++) {
      const a = out[i], b = out[(i + 1) % n];
      if (orient[i] === "H") { const m = (a.y + b.y) / 2; a.y = m; b.y = m; }
      else { const m = (a.x + b.x) / 2; a.x = m; b.x = m; }
    }
  }
  return out;
}

function clusterSnapPoly(pts: Pt[], eps = 0.02): Pt[] {
  const cl = (vals: number[]) => {
    const s = [...new Set(vals)].sort((a, b) => a - b);
    const groups: number[][] = [];
    let cur = [s[0]];
    for (let k = 1; k < s.length; k++) {
      if (s[k] - cur[cur.length - 1] <= eps) cur.push(s[k]);
      else { groups.push(cur); cur = [s[k]]; }
    }
    groups.push(cur);
    const m = new Map<number, number>();
    for (const g of groups) { const av = g.reduce((a, b) => a + b, 0) / g.length; g.forEach((v) => m.set(v, av)); }
    return m;
  };
  const xm = cl(pts.map((p) => p.x)), ym = cl(pts.map((p) => p.y));
  return pts.map((p) => ({ x: xm.get(p.x)!, y: ym.get(p.y)! }));
}

function dropCollinearPoly(pts: Pt[], ar: number, tolDeg = 6): Pt[] {
  const out = pts.map((p) => ({ ...p }));
  const tol = Math.sin((tolDeg * Math.PI) / 180);
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const v1x = (a.x - b.x) * ar, v1y = a.y - b.y, v2x = (c.x - b.x) * ar, v2y = c.y - b.y;
      const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
      if (m1 > 0 && m2 > 0 && Math.abs(v1x * v2y - v1y * v2x) / (m1 * m2) < tol) {
        out.splice(i, 1); changed = true; break;
      }
    }
  }
  return out;
}

function polyAreaCorrected(pts: Pt[], ar: number): number {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; s += (a.x * ar) * b.y - (b.x * ar) * a.y; }
  return Math.abs(s) / 2;
}

function _avgCentroid(pts: Pt[]): Pt {
  const n = pts.length;
  return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
}

/** Length-weighted dominant wall angle (radians), period 90° so perpendicular walls agree,
 * folded to [-45°, 45°]. Lets us de-rotate a room to its own orientation before straightening. */
function _dominantAngle(corr: Pt[]): number {
  let s = 0, c = 0;
  const n = corr.length;
  for (let i = 0; i < n; i++) {
    const a = corr[i], b = corr[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    s += L * Math.sin(4 * ang);
    c += L * Math.cos(4 * ang);
  }
  return Math.atan2(s, c) / 4;
}

function _rot(p: Pt, ang: number, cen: Pt): Pt {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const x = p.x - cen.x, y = p.y - cen.y;
  return { x: cen.x + x * ca - y * sa, y: cen.y + x * sa + y * ca };
}

/** Returns a rectilinearized polygon (squared to the room's OWN orientation, so rotated floor
 * plans stay rotated), or null if the shape is genuinely angled (can't be squared without
 * collapsing) — so the button safely refuses those. */
function straightenPolygon(pts: Pt[], ar: number): Pt[] | null {
  if (pts.length < 4) return null;
  // aspect-corrected -> de-rotate to the room's dominant angle -> straighten -> rotate back
  const corr = pts.map((p) => ({ x: p.x * ar, y: p.y }));
  const theta = _dominantAngle(corr);
  const cen = _avgCentroid(corr);
  const rot = corr.map((p) => _rot(p, -theta, cen));
  // Only straighten a room that is ALREADY predominantly rectilinear in its own frame — refuse
  // genuinely-angled shapes (chamfers, real hexagons) instead of distorting them into a wrong box.
  const nearAxis = rot.reduce((cnt, a, i) => {
    const b = rot[(i + 1) % rot.length];
    const deg = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    const off = Math.min(deg, Math.abs(90 - deg)); // distance to nearest axis
    return cnt + (off <= 18 ? 1 : 0);
  }, 0);
  if (nearAxis < rot.length - 1) return null;
  let s = rectilinearizePoly(rot, 1);
  s = clusterSnapPoly(s);
  s = dropCollinearPoly(s, 1);
  const before = polyAreaCorrected(corr, 1);
  const after = polyAreaCorrected(s, 1);
  if (s.length < 4 || before <= 0 || after / before < 0.6) return null;
  return s.map((p) => _rot(p, theta, cen)).map((p) => ({ x: p.x / ar, y: p.y }));
}

export default function RoomConfirmCanvas({
  imageUrl,
  allRooms,
  currentRoomIndex,
  adjustMode,
  onShapeDrawn,
}: Props) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const transformDivRef = useRef<HTMLDivElement>(null);
  const imgRef         = useRef<HTMLImageElement | null>(null);
  const drawCanvasRef  = useRef<HTMLCanvasElement>(null);
  const drawRef        = useRef<(() => void) | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [drawMode,   setDrawMode]   = useState<DrawMode>("rectangle");
  const [dragPhase,  setDragPhase]  = useState<"idle" | "drawing" | "confirmed">("idle");
  const [rotAngle,   setRotAngle]   = useState(0);
  const [polyPoints, setPolyPoints] = useState<{ x: number; y: number }[]>([]); // fractions
  const [polyDone,   setPolyDone]   = useState(false);
  const [interactionMode, setInteractionMode] = useState<"view" | "draw">("view");
  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const [spacePan, setSpacePan] = useState(false); // hold Space to pan while adjusting (desktop)
  const [isTouch, setIsTouch] = useState(false);   // touch device -> two-finger pan instead of Space
  const [straightenNote, setStraightenNote] = useState<string | null>(null);
  const straightenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Refs (always-current values for event handlers) ───────────────────────
  const drawModeRef   = useRef<DrawMode>("rectangle");
  const dragPhaseRef  = useRef<"idle" | "drawing" | "confirmed">("idle");
  const rotAngleRef   = useRef(0);
  const polyPointsRef = useRef<{ x: number; y: number }[]>([]);  // fractions
  const polyDoneRef   = useRef(false);
  const interactionModeRef = useRef<"view" | "draw">("view");
  const lastClickRef = useRef<{ time: number; index: number | null }>({ time: 0, index: null });

  const dragStartRef   = useRef<{ x: number; y: number } | null>(null);  // fractions
  const dragCurrentRef = useRef<{ x: number; y: number } | null>(null);  // fractions
  const rotSubPhaseRef = useRef<"none" | "rect_drawn" | "rotating">("none");
  const rotRectRef     = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const pointerPosRef  = useRef<{ x: number; y: number } | null>(null);  // fractions

  const activeHandleRef  = useRef<string>("none");
  const prevPointerRef   = useRef<{ x: number; y: number } | null>(null);

  const zoomRef       = useRef(1);
  const panRef        = useRef({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastPanPos    = useRef({ x: 0, y: 0 });
  const isPanning     = useRef(false);
  const spacePanRef   = useRef(false);

  // Vertex-align snap (straighten polygons): guide axes shown while dragging a corner, and
  // whether Alt is held (free-drag, snap disabled).
  const snapGuideRef  = useRef<Array<{ x1: number; y1: number; x2: number; y2: number }>>([]);
  const dragAltRef    = useRef(false);

  // ── Sync helpers ──────────────────────────────────────────────────────────
  function setDP(p: "idle" | "drawing" | "confirmed") { dragPhaseRef.current = p; setDragPhase(p); }
  function setRA(a: number)  { rotAngleRef.current = a; setRotAngle(a); }
  function setPP(pts: { x: number; y: number }[]) { polyPointsRef.current = pts; setPolyPoints(pts); }
  function setPD(d: boolean) { polyDoneRef.current = d; setPolyDone(d); }
  function updateZoom(z: number) { zoomRef.current = z; setZoom(z); }
  function updatePan(p: { x: number; y: number }) { panRef.current = p; setPan(p); }
  function setIM(m: "view" | "draw") { interactionModeRef.current = m; setInteractionMode(m); }

  // ── Pan constraint ────────────────────────────────────────────────────────
  function constrainPan(px: number, py: number, z: number) {
    const img = imgRef.current;
    if (!img || z <= 1) return { x: 0, y: 0 };
    const W = img.offsetWidth;
    const H = img.offsetHeight;
    return {
      x: Math.max(-(W * (z - 1)), Math.min(0, px)),
      y: Math.max(-(H * (z - 1)), Math.min(0, py)),
    };
  }

  // ── Unified draw function (canvas-internal zoom/pan) ─────────────────────
  const drawCanvas = useCallback(() => {
    const canvas = drawCanvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !img.complete || img.naturalWidth === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const W = img.offsetWidth;
    const H = img.offsetHeight;
    if (W === 0 || H === 0) return;

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + "px";
    canvas.style.height = H + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);  // DPR scale — all coords now in CSS px

    const z = zoomRef.current;

    // ── Other rooms + AI overlay — hidden in draw mode ─────────────────────
    if (interactionModeRef.current !== "draw") {
      allRooms.forEach((room, i) => {
        if (i === currentRoomIndex || !room.bbox) return;
        const { x, y, w, h } = room.bbox;
        ctx.strokeStyle = "rgba(0,0,0,0.14)";
        ctx.setLineDash([3 / z, 4 / z]);
        ctx.lineWidth = 1 / z;
        ctx.strokeRect(x * W, y * H, w * W, h * H);
        ctx.setLineDash([]);
      });

      // ── Current room AI bbox / polygon ───────────────────────────────────
      const currentRoom = allRooms[currentRoomIndex];
      const showAiBbox = currentRoom?.bbox && (!adjustMode || dragPhaseRef.current === "idle");
      if (showAiBbox && currentRoom?.bbox) {
        const { x, y, w, h } = currentRoom.bbox;
        const px = x * W, py = y * H, pw = w * W, ph = h * H;
        const conf = currentRoom.confidence ?? 0;
        const hi = conf >= 0.75 || currentRoom.source === "user_marked";
        const strokeColor = hi ? "#1A6B3C" : "#B45309";
        const fillColor   = hi ? "rgba(26,107,60,0.18)" : "rgba(180,83,9,0.14)";

        const cs = currentRoom.shape;
        const aiPolyRaw: Array<{ x: number; y: number }> | null = (() => {
          if (cs?.polygonPoints && cs.polygonPoints.length >= 3) return cs.polygonPoints;
          const sp = (cs as Record<string, unknown>)?.polygon_points as Array<{ x: number; y: number }> | undefined;
          if (sp && sp.length >= 3) return sp;
          if (currentRoom.polygon_points && currentRoom.polygon_points.length >= 3) return currentRoom.polygon_points;
          return null;
        })();
        if (aiPolyRaw) console.log(`[RoomConfirmCanvas] ${currentRoom.room_name}: polygon_points=${aiPolyRaw.length}`);
        const aiPoly = aiPolyRaw && isValidPolygon(aiPolyRaw, W, H) ? aiPolyRaw : null;

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.5 / z;

        let labelCx = px + pw / 2;
        let labelCy = py + ph / 2;
        let corners: Array<{ x: number; y: number }> = [];

        if (aiPoly) {
          const pts = aiPoly.map((p) => ({ x: p.x * W, y: p.y * H }));
          ctx.beginPath();
          pts.forEach((pt, idx) => (idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
          ctx.closePath();
          ctx.fillStyle = fillColor;
          ctx.fill();
          ctx.stroke();
          
          corners = pts;
          const centroid = getPolygonCentroid(pts);
          labelCx = centroid.x;
          labelCy = centroid.y;
        } else {
          ctx.fillStyle = fillColor;
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeRect(px, py, pw, ph);
          
          corners = [
            { x: px, y: py },
            { x: px + pw, y: py },
            { x: px + pw, y: py + ph },
            { x: px, y: py + ph }
          ];
        }

        // Draw corner markers in View Mode
        corners.forEach((pt) => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 4.5 / z, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1.5 / z;
          ctx.stroke();
        });

        // Draw center of mass target crosshair marker
        ctx.beginPath();
        ctx.arc(labelCx, labelCy, 7 / z, 0, Math.PI * 2);
        ctx.fillStyle = strokeColor;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5 / z;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(labelCx - 4.5 / z, labelCy);
        ctx.lineTo(labelCx + 4.5 / z, labelCy);
        ctx.moveTo(labelCx, labelCy - 4.5 / z);
        ctx.lineTo(labelCx, labelCy + 4.5 / z);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.2 / z;
        ctx.stroke();

        // Draw text label badge floating directly below center of mass
        const fontSize = Math.max(11, Math.min(14, pw * 0.15)) / z;
        ctx.font = `bold ${fontSize}px sans-serif`;
        const tw = ctx.measureText(currentRoom.room_name).width;
        const lw = tw + 12 / z, lh = fontSize + 8 / z;
        const textY = labelCy + lh / 2 + 10 / z;
        const lx = labelCx - lw / 2, ly = textY - lh / 2;
        ctx.fillStyle = hi ? "rgba(26,107,60,0.9)" : "rgba(180,83,9,0.9)";
        ctx.fillRect(lx, ly, lw, lh);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(currentRoom.room_name, labelCx, textY);
      }
    }

    // ── Active drawing ──────────────────────────────────────────────────────
    const mode  = drawModeRef.current;
    const phase = dragPhaseRef.current;

    if (mode === "rectangle") {
      const s = dragStartRef.current, c = dragCurrentRef.current;
      if (s && c) {
        const rx = Math.min(s.x, c.x) * W, ry = Math.min(s.y, c.y) * H;
        const rw = Math.abs(c.x - s.x) * W, rh = Math.abs(c.y - s.y) * H;
        if (phase === "drawing") {
          ctx.strokeStyle = "#EF4444"; ctx.setLineDash([6 / z, 4 / z]); ctx.lineWidth = 2 / z;
        } else {
          ctx.strokeStyle = "#16A34A"; ctx.setLineDash([]); ctx.lineWidth = 2.5 / z;
          ctx.fillStyle = "rgba(22,163,74,0.12)"; ctx.fillRect(rx, ry, rw, rh);
        }
        ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
      }
    }

    else if (mode === "rotated") {
      const s = dragStartRef.current, c = dragCurrentRef.current;
      const rr = rotRectRef.current;
      if (rotSubPhaseRef.current === "none" && s && c) {
        // Drawing initial rect
        const rx = Math.min(s.x, c.x) * W, ry = Math.min(s.y, c.y) * H;
        const rw = Math.abs(c.x - s.x) * W, rh = Math.abs(c.y - s.y) * H;
        ctx.strokeStyle = "#EF4444"; ctx.setLineDash([6 / z, 4 / z]); ctx.lineWidth = 2 / z;
        ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
      } else if (rr) {
        const rcx = (rr.x1 + rr.x2) / 2 * W;
        const rcy = (rr.y1 + rr.y2) / 2 * H;
        const rw  = Math.abs(rr.x2 - rr.x1) * W;
        const rh  = Math.abs(rr.y2 - rr.y1) * H;
        const a   = rotAngleRef.current;
        ctx.save();
        ctx.translate(rcx, rcy); ctx.rotate(a);
        ctx.fillStyle = "rgba(22,163,74,0.12)"; ctx.fillRect(-rw / 2, -rh / 2, rw, rh);
        ctx.strokeStyle = "#16A34A"; ctx.lineWidth = 2.5 / z; ctx.strokeRect(-rw / 2, -rh / 2, rw, rh);
        ctx.restore();
        // Rotation handle line + circle
        const offset = rh / 2 + 20 / z;
        const hx = rcx + offset * Math.sin(a), hy = rcy - offset * Math.cos(a);
        ctx.beginPath(); ctx.moveTo(rcx, rcy); ctx.lineTo(hx, hy);
        ctx.strokeStyle = "rgba(139,26,26,0.5)"; ctx.lineWidth = 1 / z; ctx.setLineDash([3 / z, 3 / z]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(hx, hy, 8 / z, 0, Math.PI * 2);
        ctx.fillStyle = "#8B1A1A"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 / z; ctx.stroke();
        const deg = Math.round(a * 180 / Math.PI);
        ctx.font = `bold ${12 / z}px sans-serif`; ctx.fillStyle = "#8B1A1A";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(`${deg}°`, rcx, rcy - rh * 0.5 * Math.cos(a) - 28 / z);
        // Corner resize handles + center move handle
        if (phase === "confirmed") {
          const corners = getRotatedCornersPx(rr, a, W, H);
          const hs = 12 / z;
          corners.forEach((corner) => {
            ctx.fillStyle = "#fff"; ctx.strokeStyle = "#8B1A1A"; ctx.lineWidth = 2 / z;
            ctx.fillRect(corner.x - hs / 2, corner.y - hs / 2, hs, hs);
            ctx.strokeRect(corner.x - hs / 2, corner.y - hs / 2, hs, hs);
          });
          ctx.beginPath(); ctx.arc(rcx, rcy, 9 / z, 0, Math.PI * 2);
          ctx.fillStyle = "#8B1A1A"; ctx.fill();
          ctx.fillStyle = "#fff"; ctx.font = `bold ${11 / z}px sans-serif`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("✥", rcx, rcy);
        }
      }
    }

    else if (mode === "polygon") {
      const pts  = polyPointsRef.current;   // fractions
      const done = polyDoneRef.current;
      const ptr  = pointerPosRef.current;   // fractions

      if (pts.length >= 3) {
        ctx.beginPath();
        pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x * W, pt.y * H) : ctx.lineTo(pt.x * W, pt.y * H)));
        if (done) ctx.closePath();
        ctx.fillStyle = "rgba(163,45,45,0.12)"; ctx.fill();
      }
      if (pts.length >= 2) {
        ctx.beginPath();
        pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x * W, pt.y * H) : ctx.lineTo(pt.x * W, pt.y * H)));
        if (done) ctx.closePath();
        ctx.strokeStyle = "#A32D2D"; ctx.lineWidth = 2 / z; ctx.setLineDash([]); ctx.stroke();
      }
      if (!done && ptr && pts.length > 0) {
        const last = pts[pts.length - 1];
        ctx.beginPath(); ctx.moveTo(last.x * W, last.y * H);
        ctx.lineTo(ptr.x * W, ptr.y * H);
        ctx.strokeStyle = "#A32D2D"; ctx.setLineDash([4 / z, 4 / z]); ctx.lineWidth = 1.5 / z;
        ctx.stroke(); ctx.setLineDash([]);
      }
      pts.forEach((pt, i) => {
        ctx.beginPath(); ctx.arc(pt.x * W, pt.y * H, (i === 0 ? 8 : 5) / z, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#A32D2D" : "#fff"; ctx.fill();
        ctx.strokeStyle = "#A32D2D"; ctx.lineWidth = 2 / z; ctx.stroke();
      });
      // Vertex-align snap guides (shown while dragging a corner that lines up with another)
      {
        const guides = snapGuideRef.current;
        if (guides.length) {
          ctx.strokeStyle = "rgba(37,99,235,0.7)";
          ctx.lineWidth = 1 / z;
          ctx.setLineDash([5 / z, 4 / z]);
          guides.forEach((g) => {
            ctx.beginPath();
            ctx.moveTo(g.x1 * W, g.y1 * H);
            ctx.lineTo(g.x2 * W, g.y2 * H);
            ctx.stroke();
          });
          ctx.setLineDash([]);
        }
      }
      // Center move handle (when polygon is closed)
      if (done && pts.length >= 3) {
        const ptsPx = pts.map(pt => ({ x: pt.x * W, y: pt.y * H }));
        const centroid = getPolygonCentroid(ptsPx);
        const cxPx = centroid.x;
        const cyPx = centroid.y;
        
        ctx.beginPath(); ctx.arc(cxPx, cyPx, 9 / z, 0, Math.PI * 2);
        ctx.fillStyle = "#A32D2D"; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = `bold ${11 / z}px sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("✥", cxPx, cyPx);
      }
    }

  }, [allRooms, currentRoomIndex, adjustMode, zoom, dragPhase, interactionMode, drawMode, rotAngle, polyPoints, polyDone]);

  useEffect(() => { drawRef.current = drawCanvas; }, [drawCanvas]);
  useEffect(() => { drawCanvas(); }, [drawCanvas]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => drawRef.current?.());
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  // Scroll wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(1, Math.min(5, zoomRef.current * factor));
      const newPan  = newZoom === 1 ? { x: 0, y: 0 } : constrainPan(panRef.current.x, panRef.current.y, newZoom);
      updateZoom(newZoom);
      updatePan(newPan);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset or load initial drawing state on room/mode change
  useEffect(() => {
    if (adjustMode) {
      setIM("draw");
      loadRoomShape();
    } else {
      resetDrawState();
      setIM("view");
    }
    updateZoom(1);
    updatePan({ x: 0, y: 0 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustMode, currentRoomIndex]);

  // ── Coordinate helpers ────────────────────────────────────────────────────
  function getImageFraction(clientX: number, clientY: number) {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const r = img.getBoundingClientRect();  // img is NOT transformed — accurate
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (clientY - r.top)  / r.height)),
    };
  }

  // Convert a screen pointer to image-space coords.
  // getBoundingClientRect() already includes CSS zoom/pan, so frac * naturalSize = natural px.
  function toImageSpace(frac: { x: number; y: number }) {
    const img = imgRef.current;
    if (!img) return frac;
    const W = img.offsetWidth, H = img.offsetHeight;
    return { x: frac.x * W, y: frac.y * H };
  }

  function getHandleImagePos() {
    const img = imgRef.current;
    const rr  = rotRectRef.current;
    if (!img || !rr) return null;
    const W = img.offsetWidth, H = img.offsetHeight;
    const rcx = (rr.x1 + rr.x2) / 2 * W;
    const rcy = (rr.y1 + rr.y2) / 2 * H;
    const rh  = Math.abs(rr.y2 - rr.y1) * H;
    const a   = rotAngleRef.current;
    const offset = rh / 2 + 20 / zoomRef.current;
    return { x: rcx + offset * Math.sin(a), y: rcy - offset * Math.cos(a) };
  }

  function isOnHandle(clientX: number, clientY: number) {
    const h = getHandleImagePos();
    if (!h) return false;
    const frac = getImageFraction(clientX, clientY);
    const is   = toImageSpace(frac);
    const threshold = 15 / zoomRef.current;
    return Math.sqrt((is.x - h.x) ** 2 + (is.y - h.y) ** 2) <= threshold;
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  function resetDrawState() {
    setDP("idle");
    dragStartRef.current = null; dragCurrentRef.current = null;
    rotSubPhaseRef.current = "none"; rotRectRef.current = null;
    setRA(0); setPP([]); setPD(false); pointerPosRef.current = null;
    activeHandleRef.current = "none"; prevPointerRef.current = null;
    drawRef.current?.();
  }

  // Load the current room's polygon (its AI prediction, or last-confirmed shape) into the draw
  // state — falling back to a box from the bbox. Used on entering adjust mode, on the "Draw"
  // button, and on Cancel, so the user is never dumped onto a blank canvas / forced to redraw.
  function loadRoomShape() {
    drawModeRef.current = "polygon";
    setDrawMode("polygon");
    const currentRoom = allRooms[currentRoomIndex];
    let pts: Array<{ x: number; y: number }> = [];
    if (currentRoom) {
      const cs = currentRoom.shape;
      const polyRaw: Array<{ x: number; y: number }> | undefined =
        currentRoom.polygon_points || cs?.polygonPoints || (cs as { polygon_points?: Array<{ x: number; y: number }> })?.polygon_points;
      if (polyRaw && polyRaw.length >= 3) {
        pts = polyRaw;
      } else if (currentRoom.bbox) {
        const { x, y, w, h } = currentRoom.bbox;
        pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      }
    }
    if (pts.length >= 3) {
      setPP(pts); setPD(true); setDP("confirmed");
    } else {
      resetDrawState(); drawModeRef.current = "polygon"; setDrawMode("polygon");
    }
  }

  function changeDrawMode(mode: DrawMode) {
    drawModeRef.current = mode; setDrawMode(mode); resetDrawState();
  }

  function closePolygon() {
    setPD(true); setDP("confirmed"); drawRef.current?.();
  }

  function undoLastPoint() {
    const pts = polyPointsRef.current.slice(0, -1);
    setPP(pts); drawRef.current?.();
  }

  // One-click straighten: rectilinearize the current polygon (see straightenPolygon). Refuses
  // genuinely angled shapes (guard) with a brief note. Reversible via manual drag / Redraw.
  function handleStraighten() {
    const img = imgRef.current;
    const ar = img && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
    const result = straightenPolygon(polyPointsRef.current, ar);
    if (straightenTimer.current) clearTimeout(straightenTimer.current);
    if (!result) {
      setStraightenNote("This room is angled — it can't be squared to right angles.");
      straightenTimer.current = setTimeout(() => setStraightenNote(null), 2800);
      return;
    }
    setPP(result);
    setStraightenNote(null);
    drawRef.current?.();
  }

  function handleCancelDraw() {
    // Discard this session's edits and restore the room's AI-predicted (or last-confirmed) shape,
    // rather than leaving a blank canvas that forces a redraw.
    loadRoomShape();
    setIM("view");
  }

  // ── Draw mode pointer handlers ────────────────────────────────────────────
  function handlePointerDown(clientX: number, clientY: number) {
    if (!adjustMode) return;
    const mode  = drawModeRef.current;
    const phase = dragPhaseRef.current;
    const frac  = getImageFraction(clientX, clientY);

    if (mode === "rectangle") {
      if (phase === "confirmed") return;
      dragStartRef.current = frac; dragCurrentRef.current = frac; setDP("drawing");
      drawRef.current?.();
    }
    else if (mode === "rotated") {
      if (phase === "idle") {
        dragStartRef.current = frac; dragCurrentRef.current = frac;
        rotSubPhaseRef.current = "none"; setDP("drawing"); drawRef.current?.();
      } else if (phase === "confirmed") {
        const img = imgRef.current; if (!img || !rotRectRef.current) return;
        const W = img.offsetWidth, H = img.offsetHeight;
        const is = toImageSpace(frac);
        const threshold = 15 / zoomRef.current;
        const rr = rotRectRef.current;
        const rcx = (rr.x1 + rr.x2) / 2 * W, rcy = (rr.y1 + rr.y2) / 2 * H;
        if (Math.sqrt((is.x - rcx) ** 2 + (is.y - rcy) ** 2) < threshold) {
          activeHandleRef.current = "move"; prevPointerRef.current = is; return;
        }
        const corners = getRotatedCornersPx(rr, rotAngleRef.current, W, H);
        const names = ["corner-tl", "corner-tr", "corner-br", "corner-bl"];
        for (let ci = 0; ci < corners.length; ci++) {
          if (Math.sqrt((is.x - corners[ci].x) ** 2 + (is.y - corners[ci].y) ** 2) < threshold) {
            activeHandleRef.current = names[ci]; prevPointerRef.current = is; return;
          }
        }
        if (isOnHandle(clientX, clientY)) rotSubPhaseRef.current = "rotating";
      }
    }
    else if (mode === "polygon") {
      if (polyDoneRef.current) {
        const img = imgRef.current; if (!img) return;
        const W = img.offsetWidth, H = img.offsetHeight;
        const is = toImageSpace(frac);
        const pts = polyPointsRef.current;
        const threshold = 28 / zoomRef.current;

        // Check for double click/tap to delete a vertex
        const now = Date.now();
        let clickedPointIdx: number | null = null;
        for (let pi = 0; pi < pts.length; pi++) {
          if (Math.sqrt((is.x - pts[pi].x * W) ** 2 + (is.y - pts[pi].y * H) ** 2) < threshold) {
            clickedPointIdx = pi;
            break;
          }
        }

        if (clickedPointIdx !== null) {
          const timeDiff = now - lastClickRef.current.time;
          if (timeDiff < 300 && lastClickRef.current.index === clickedPointIdx) {
            // Double click detected on vertex clickedPointIdx!
            if (pts.length > 3) {
              const updatedPts = pts.filter((_, idx) => idx !== clickedPointIdx);
              setPP(updatedPts);
              drawRef.current?.();
              lastClickRef.current = { time: 0, index: null };
              return;
            }
          }
          lastClickRef.current = { time: now, index: clickedPointIdx };
          activeHandleRef.current = `poly-point-${clickedPointIdx}`;
          prevPointerRef.current = is;
          return;
        }

        if (pts.length >= 3) {
          const ptsPx = pts.map(pt => ({ x: pt.x * W, y: pt.y * H }));
          const centroid = getPolygonCentroid(ptsPx);
          if (Math.sqrt((is.x - centroid.x) ** 2 + (is.y - centroid.y) ** 2) < threshold) {
            activeHandleRef.current = "poly-move"; prevPointerRef.current = is; return;
          }
        }

        // If we didn't click a vertex or the move handle, check if we clicked on an edge to insert a new vertex
        let minEdgeDist = Infinity;
        let insertIndex = -1;
        let insertFrac = { x: 0, y: 0 };
        
        for (let i = 0; i < pts.length; i++) {
          const p1 = pts[i];
          const p2 = pts[(i + 1) % pts.length];
          const res = getDistanceToSegment(is.x, is.y, p1.x * W, p1.y * H, p2.x * W, p2.y * H);
          if (res.dist < minEdgeDist) {
            minEdgeDist = res.dist;
            insertIndex = i + 1; // Insert after p1
            insertFrac = { x: res.x / W, y: res.y / H };
          }
        }
        
        if (minEdgeDist < 22 / zoomRef.current) { // click within 22px of the edge
          const updatedPts = [...pts];
          updatedPts.splice(insertIndex, 0, insertFrac);
          setPP(updatedPts);
          activeHandleRef.current = `poly-point-${insertIndex}`;
          prevPointerRef.current = is;
          drawRef.current?.();
          lastClickRef.current = { time: now, index: insertIndex };
          return;
        }

        return; // tap outside handles when done — do nothing
      }
      const img = imgRef.current;
      if (!img) return;
      const W = img.offsetWidth, H = img.offsetHeight;
      const pts = polyPointsRef.current;
      if (pts.length >= 3) {
        const first = pts[0];
        const dx = (frac.x - first.x) * W;
        const dy = (frac.y - first.y) * H;
        if (Math.sqrt(dx * dx + dy * dy) <= 15 / zoomRef.current) {
          closePolygon(); return;
        }
      }
      setPP([...pts, frac]);
      drawRef.current?.();
    }
  }

  // Vertex-align snap: while dragging corner `idx`, snap its X (and/or Y independently) to
  // line up with the nearest OTHER corner within a small on-screen threshold, so a stager can
  // straighten an over-angular polygon into clean axis-aligned walls. Alt disables it. Returns
  // the (possibly snapped) fraction position plus the guide axes to draw (gx/gy), if any.
  function snapVertex(idx: number, nx: number, ny: number, W: number, H: number) {
    const noGuide: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    if (dragAltRef.current) return { x: nx, y: ny, guides: noGuide };
    const img = imgRef.current;
    const ar = img && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
    const pts = polyPointsRef.current;
    // Align in the room's OWN rotated, aspect-corrected frame so corners line up along the walls,
    // not the screen axes (correct for rotated floor plans).
    const corr = pts.map((p) => ({ x: p.x * ar, y: p.y }));
    const theta = _dominantAngle(corr);
    const cen = _avgCentroid(corr);
    const derot = corr.map((p) => _rot(p, -theta, cen));
    const dragged = _rot({ x: nx * ar, y: ny }, -theta, cen);
    const z = zoomRef.current;
    let thX = (7 / (W * z)) * ar;   // ~7 screen px, tighter as you zoom in
    let thY = 7 / (H * z);
    let gx: number | null = null;
    let gy: number | null = null;
    for (let i = 0; i < derot.length; i++) {
      if (i === idx) continue;
      const dx = Math.abs(derot[i].x - dragged.x);
      if (dx < thX) { thX = dx; gx = derot[i].x; }
      const dy = Math.abs(derot[i].y - dragged.y);
      if (dy < thY) { thY = dy; gy = derot[i].y; }
    }
    const snapped = { x: gx !== null ? gx : dragged.x, y: gy !== null ? gy : dragged.y };
    const back = _rot(snapped, theta, cen);
    // guide lines along the room's rotated axes, through the aligned coordinate (fraction space)
    const guides = noGuide;
    const toFrac = (p: Pt) => { const q = _rot(p, theta, cen); return { x: q.x / ar, y: q.y }; };
    const SPAN = 2.0;
    if (gx !== null) { const a = toFrac({ x: gx, y: cen.y - SPAN }), b = toFrac({ x: gx, y: cen.y + SPAN }); guides.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
    if (gy !== null) { const a = toFrac({ x: cen.x - SPAN, y: gy }), b = toFrac({ x: cen.x + SPAN, y: gy }); guides.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
    return { x: back.x / ar, y: back.y, guides };
  }

  function handlePointerMove(clientX: number, clientY: number) {
    if (!adjustMode) return;
    const mode  = drawModeRef.current;
    const phase = dragPhaseRef.current;
    const frac  = getImageFraction(clientX, clientY);
    const img   = imgRef.current;

    // ── Handle dragging (move/resize/vertex) ──────────────────────────────
    const handle = activeHandleRef.current;
    if (handle !== "none" && prevPointerRef.current !== null && img) {
      const W = img.offsetWidth, H = img.offsetHeight;
      const is = toImageSpace(frac);
      const prev = prevPointerRef.current;
      const dxF = (is.x - prev.x) / W, dyF = (is.y - prev.y) / H;

      if (handle === "move" && rotRectRef.current) {
        const rr = rotRectRef.current;
        rotRectRef.current = { x1: rr.x1 + dxF, y1: rr.y1 + dyF, x2: rr.x2 + dxF, y2: rr.y2 + dyF };
      } else if (handle.startsWith("corner-") && rotRectRef.current) {
        const corner = handle.slice(7) as "tl" | "tr" | "br" | "bl";
        rotRectRef.current = resizeRotatedCorner(rotRectRef.current, rotAngleRef.current, corner, is.x, is.y, W, H);
      } else if (handle === "poly-move") {
        setPP(polyPointsRef.current.map((p) => ({ x: Math.max(0, Math.min(1, p.x + dxF)), y: Math.max(0, Math.min(1, p.y + dyF)) })));
      } else if (handle.startsWith("poly-point-")) {
        const idx = parseInt(handle.slice(11));
        const pts = [...polyPointsRef.current];
        const rawX = Math.max(0, Math.min(1, is.x / W));
        const rawY = Math.max(0, Math.min(1, is.y / H));
        const snapped = snapVertex(idx, rawX, rawY, W, H);
        snapGuideRef.current = snapped.guides;
        pts[idx] = { x: Math.max(0, Math.min(1, snapped.x)), y: Math.max(0, Math.min(1, snapped.y)) };
        setPP(pts);
      }
      prevPointerRef.current = is;
      drawRef.current?.();
      return;
    }

    if (mode === "rectangle" && phase === "drawing") {
      dragCurrentRef.current = frac; drawRef.current?.();
    }
    else if (mode === "rotated") {
      if (phase === "drawing" && rotSubPhaseRef.current === "none") {
        dragCurrentRef.current = frac; drawRef.current?.();
      } else if (rotSubPhaseRef.current === "rotating") {
        const rr  = rotRectRef.current;
        if (!img || !rr) return;
        const W = img.offsetWidth, H = img.offsetHeight;
        const rcx = (rr.x1 + rr.x2) / 2 * W;
        const rcy = (rr.y1 + rr.y2) / 2 * H;
        const is  = toImageSpace(frac);
        const newAngle = Math.atan2(is.y - rcy, is.x - rcx) + Math.PI / 2;
        setRA(newAngle); drawRef.current?.();
      }
    }
    else if (mode === "polygon" && !polyDoneRef.current) {
      pointerPosRef.current = frac; drawRef.current?.();
    }
  }

  function handlePointerUp(clientX: number, clientY: number) {
    if (!adjustMode) return;
    if (activeHandleRef.current !== "none") {
      activeHandleRef.current = "none"; prevPointerRef.current = null;
      snapGuideRef.current = [];
      drawRef.current?.(); return;
    }
    const mode  = drawModeRef.current;
    const phase = dragPhaseRef.current;
    const frac  = getImageFraction(clientX, clientY);

    if (mode === "rectangle" && phase === "drawing") {
      dragCurrentRef.current = frac;
      const s = dragStartRef.current, c = frac;
      if (s && Math.abs(c.x - s.x) > 0.02 && Math.abs(c.y - s.y) > 0.02) {
        setDP("confirmed");
      } else {
        dragStartRef.current = null; dragCurrentRef.current = null; setDP("idle");
      }
      drawRef.current?.();
    }
    else if (mode === "rotated") {
      if (phase === "drawing" && rotSubPhaseRef.current === "none") {
        dragCurrentRef.current = frac;
        const s = dragStartRef.current;
        if (s) {
          rotRectRef.current = {
            x1: Math.min(s.x, frac.x), y1: Math.min(s.y, frac.y),
            x2: Math.max(s.x, frac.x), y2: Math.max(s.y, frac.y),
          };
        }
        rotSubPhaseRef.current = "rect_drawn"; setRA(0); setDP("confirmed"); drawRef.current?.();
      } else if (rotSubPhaseRef.current === "rotating") {
        rotSubPhaseRef.current = "rect_drawn"; drawRef.current?.();
      }
    }
  }

  // Global mouseup — catches releases outside the canvas
  useEffect(() => {
    if (dragPhase !== "drawing" || interactionMode !== "draw") return;
    const handler = (e: MouseEvent) => handlePointerUp(e.clientX, e.clientY);
    window.addEventListener("mouseup", handler);
    return () => window.removeEventListener("mouseup", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragPhase, interactionMode]);

  // Detect a touch-primary device so the pan hint shows the right gesture.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      setIsTouch(window.matchMedia("(pointer: coarse)").matches);
    }
  }, []);

  // Hold Space to temporarily pan while in adjust mode (desktop hand tool).
  useEffect(() => {
    if (!adjustMode) return;
    const isFormEl = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isFormEl(e.target)) {
        if (!spacePanRef.current) { spacePanRef.current = true; setSpacePan(true); }
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spacePanRef.current = false; setSpacePan(false); isPanning.current = false;
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [adjustMode]);

  // ── View mode (pan) handlers ──────────────────────────────────────────────
  function handleViewMouseDown(clientX: number, clientY: number) {
    isPanning.current = true;
    lastPanPos.current = { x: clientX, y: clientY };
  }
  function handleViewMouseMove(clientX: number, clientY: number) {
    if (!isPanning.current) return;
    const dx = clientX - lastPanPos.current.x;
    const dy = clientY - lastPanPos.current.y;
    lastPanPos.current = { x: clientX, y: clientY };
    const newPan = constrainPan(panRef.current.x + dx, panRef.current.y + dy, zoomRef.current);
    updatePan(newPan);
  }
  function handleViewMouseUp() { isPanning.current = false; }

  function getTouchDist(t: React.TouchList) {
    const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Unified event handlers ────────────────────────────────────────────────
  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragAltRef.current = e.altKey;
    if (spacePanRef.current) { handleViewMouseDown(e.clientX, e.clientY); return; }
    if (interactionMode === "draw") handlePointerDown(e.clientX, e.clientY);
    else handleViewMouseDown(e.clientX, e.clientY);
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragAltRef.current = e.altKey;
    if (spacePanRef.current) { handleViewMouseMove(e.clientX, e.clientY); return; }
    if (interactionMode === "draw") handlePointerMove(e.clientX, e.clientY);
    else handleViewMouseMove(e.clientX, e.clientY);
  };
  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (spacePanRef.current) { handleViewMouseUp(); return; }
    if (interactionMode === "draw") handlePointerUp(e.clientX, e.clientY);
    else handleViewMouseUp();
  };
  const onMouseLeave = () => { handleViewMouseUp(); };

  const onTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    dragAltRef.current = false; // touch has no Alt; snapping always on
    if (e.touches.length === 2) {
      // Pinch — works in both modes
      isPanning.current = false;
      lastTouchDist.current = getTouchDist(e.touches);
      lastPanPos.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
      return;
    }
    if (e.touches.length === 1) {
      if (interactionMode === "draw") {
        handlePointerDown(e.touches[0].clientX, e.touches[0].clientY);
      } else {
        isPanning.current = true;
        lastTouchDist.current = null;
        lastPanPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }
  };

  const onTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      // Pinch zoom — both modes
      const newDist = getTouchDist(e.touches);
      const factor  = newDist / lastTouchDist.current;
      lastTouchDist.current = newDist;
      const newZoom = Math.max(1, Math.min(5, zoomRef.current * factor));
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = midX - lastPanPos.current.x;
      const dy = midY - lastPanPos.current.y;
      lastPanPos.current = { x: midX, y: midY };
      if (newZoom === 1) { updateZoom(1); updatePan({ x: 0, y: 0 }); }
      else {
        updateZoom(newZoom);
        updatePan(constrainPan(panRef.current.x + dx, panRef.current.y + dy, newZoom));
      }
      return;
    }
    if (e.touches.length === 1) {
      if (interactionMode === "draw") {
        handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
      } else if (isPanning.current) {
        const dx = e.touches[0].clientX - lastPanPos.current.x;
        const dy = e.touches[0].clientY - lastPanPos.current.y;
        lastPanPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        updatePan(constrainPan(panRef.current.x + dx, panRef.current.y + dy, zoomRef.current));
      }
    }
  };

  const onTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (interactionMode === "draw" && e.changedTouches[0]) {
      handlePointerUp(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    } else {
      isPanning.current = false;
      lastTouchDist.current = null;
    }
  };

  // ── Confirm shape ─────────────────────────────────────────────────────────
  function handleConfirmShape() {
    const mode = drawModeRef.current;

    if (mode === "rectangle") {
      const s = dragStartRef.current, c = dragCurrentRef.current;
      if (!s || !c) return;
      const bbox: BBox = {
        x: Math.min(s.x, c.x), y: Math.min(s.y, c.y),
        w: Math.max(0.03, Math.abs(c.x - s.x)),
        h: Math.max(0.03, Math.abs(c.y - s.y)),
      };
      onShapeDrawn(bbox, { mode: "rectangle" });
    }
    else if (mode === "rotated") {
      const rr = rotRectRef.current;
      if (!rr) return;
      const a    = rotAngleRef.current;
      const rwf  = Math.abs(rr.x2 - rr.x1), rhf = Math.abs(rr.y2 - rr.y1);
      const rcxf = (rr.x1 + rr.x2) / 2,     rcyf = (rr.y1 + rr.y2) / 2;
      const cos  = Math.abs(Math.cos(a)),     sin  = Math.abs(Math.sin(a));
      const bbox: BBox = {
        x: rcxf - (rwf * cos + rhf * sin) / 2,
        y: rcyf - (rwf * sin + rhf * cos) / 2,
        w: Math.max(0.03, rwf * cos + rhf * sin),
        h: Math.max(0.03, rwf * sin + rhf * cos),
      };
      onShapeDrawn(bbox, { mode: "rotated", rotatedRect: { cx: rcxf, cy: rcyf, w: rwf, h: rhf, angle: a } });
    }
    else if (mode === "polygon") {
      const pts = polyPointsRef.current;  // already fractions
      if (pts.length < 3) return;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const ix = Math.min(...xs), iy = Math.min(...ys);
      const iw = Math.max(...xs) - ix, ih = Math.max(...ys) - iy;
      const bbox: BBox = { x: ix, y: iy, w: Math.max(0.03, iw), h: Math.max(0.03, ih) };
      onShapeDrawn(bbox, { mode: "polygon", polygonPoints: pts });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const hintText =
    drawMode === "rotated" ? "Drag a box, then drag the handle to rotate" :
    drawMode === "polygon" ? (
      polyDone ? "Drag corners — they snap to align (hold Alt to free-drag). Click a line to add a corner. Double-click to delete." : "Tap each corner. Tap the first point to close."
    ) :
    "Drag to draw a box around the room";

  const currentRoomName = allRooms[currentRoomIndex]?.room_name ?? "";

  return (
    <div>
      {/* Canvas container */}
      <div
        ref={containerRef}
        style={{ position: "relative", width: "100%", borderRadius: "10px", overflow: "hidden", userSelect: "none" }}
      >
        {/* Transform div — image + canvas zoom/pan together via CSS */}
        <div
          ref={transformDivRef}
          style={{
            position: "relative",
            transformOrigin: "0 0",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={buildImageUrl(imageUrl)}
            alt="Floor plan"
            onLoad={() => drawRef.current?.()}
            style={{ width: "100%", display: "block" }}
            draggable={false}
          />
          {/* Single canvas for all overlays + drawing */}
          <canvas
            ref={drawCanvasRef}
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: "100%",
              touchAction: "none",
              cursor: spacePan
                ? (isPanning.current ? "grabbing" : "grab")
                : interactionMode === "draw" && adjustMode
                ? "crosshair"
                : zoom > 1 ? "grab" : "default",
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          />
        </div>

        {/* Zoom indicator — outside transform div so it stays constant size */}
        {zoom > 1 && (
          <div style={{
            position: "absolute", top: 8, left: 8,
            background: "rgba(0,0,0,0.5)", color: "#fff",
            borderRadius: "4px", padding: "2px 8px", fontSize: "11px",
            pointerEvents: "none", zIndex: 10,
          }}>
            {Math.round(zoom * 100)}%
          </div>
        )}

        {/* Zoom buttons */}
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", flexDirection: "column", gap: 4, zIndex: 10 }}>
          <button
            onClick={() => { const z = Math.min(5, zoomRef.current + 0.5); updateZoom(z); updatePan(constrainPan(panRef.current.x, panRef.current.y, z)); }}
            style={{ width: 32, height: 32, border: "none", borderRadius: 6, background: "rgba(0,0,0,0.5)", color: "#fff", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
          >+</button>
          {zoom > 1 && (
            <button
              onClick={() => { updateZoom(1); updatePan({ x: 0, y: 0 }); }}
              style={{ width: 32, height: 32, border: "none", borderRadius: 6, background: "rgba(0,0,0,0.5)", color: "#fff", fontSize: 10, cursor: "pointer" }}
            >Reset</button>
          )}
          <button
            onClick={() => { const z = Math.max(1, zoomRef.current - 0.5); if (z === 1) { updateZoom(1); updatePan({ x: 0, y: 0 }); } else { updateZoom(z); updatePan(constrainPan(panRef.current.x, panRef.current.y, z)); } }}
            style={{ width: 32, height: 32, border: "none", borderRadius: 6, background: "rgba(0,0,0,0.5)", color: "#fff", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
          >−</button>
        </div>

        {/* Pan hint (hand tool) */}
        {adjustMode && zoom > 1 && (
          <div style={{
            position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
            background: spacePan ? "rgba(37,99,235,0.9)" : "rgba(0,0,0,0.55)", color: "#fff",
            borderRadius: "6px", padding: "3px 10px", fontSize: "11px", whiteSpace: "nowrap",
            pointerEvents: "none", zIndex: 10,
          }}>
            {spacePan
              ? "Move mode — drag to pan"
              : isTouch
              ? "Pinch to zoom · drag with two fingers to move"
              : "Hold Space + drag to move"}
          </div>
        )}

        {/* Draw hint */}
        {adjustMode && interactionMode === "draw" && dragPhase === "idle" && (
          <div style={{
            position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: "6px",
            padding: "4px 12px", fontSize: "12px", whiteSpace: "nowrap", pointerEvents: "none",
          }}>
            {hintText}
          </div>
        )}
      </div>

      {/* Polygon controls */}
      {adjustMode && interactionMode === "draw" && drawMode === "polygon" && polyPoints.length > 0 && !polyDone && (
        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
          <button onClick={undoLastPoint} style={{
            height: "40px", padding: "0 14px", borderRadius: "8px",
            border: "1.5px solid #E5E7EB", background: "#fff", color: "#6B7280", fontSize: "13px", cursor: "pointer",
          }}>Undo</button>
          {polyPoints.length >= 3 && (
            <button onClick={closePolygon} style={{
              flex: 1, height: "40px", borderRadius: "8px",
              background: "#A32D2D", color: "#fff", border: "none", fontSize: "13px", fontWeight: 600, cursor: "pointer",
            }}>Close polygon</button>
          )}
        </div>
      )}

      {/* Rotated angle display */}
      {adjustMode && interactionMode === "draw" && drawMode === "rotated" && dragPhase === "confirmed" && (
        <div style={{ textAlign: "center", fontSize: "12px", color: "#8B1A1A", marginTop: "6px", fontWeight: 500 }}>
          Drag the handle to rotate · {Math.round(rotAngle * 180 / Math.PI)}°
        </div>
      )}

      {/* Straighten to right angles (polygon adjust) */}
      {adjustMode && interactionMode === "draw" && drawMode === "polygon" && polyDone && (
        <>
          <button
            onClick={handleStraighten}
            style={{
              width: "100%", height: "40px", marginTop: "8px",
              borderRadius: "8px", border: "1.5px solid #2563EB",
              background: "#EFF6FF", color: "#2563EB",
              fontSize: "13px", fontWeight: 600, cursor: "pointer",
            }}
          >
            ⊾ Straighten to right angles
          </button>
          {straightenNote && (
            <div style={{
              marginTop: "6px", fontSize: "12px", color: "#B45309",
              background: "#FEF3C7", border: "1px solid #FDE68A",
              borderRadius: "6px", padding: "6px 10px", textAlign: "center",
            }}>
              {straightenNote}
            </div>
          )}
        </>
      )}

      {/* Confirm / Redraw */}
      {adjustMode && interactionMode === "draw" && dragPhase === "confirmed" && !(drawMode === "polygon" && !polyDone) && (
        <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
          <button onClick={handleConfirmShape} style={{
            flex: 1, height: "44px", borderRadius: "10px",
            background: "#16A34A", color: "#fff", fontWeight: 600, fontSize: "14px", border: "none", cursor: "pointer",
          }}>Confirm selection</button>
          <button onClick={() => resetDrawState()} style={{
            height: "44px", padding: "0 16px", borderRadius: "10px",
            border: "1.5px solid #D1D5DB", color: "#4B5563",
            background: "#fff", fontWeight: 500, fontSize: "13px", cursor: "pointer",
          }}>Redraw</button>
        </div>
      )}

      {/* Single Cancel button — below all controls, only shown in draw mode */}
      {adjustMode && interactionMode === "draw" && (
        <button
          onClick={handleCancelDraw}
          style={{
            width: "100%", height: "40px", marginTop: "8px",
            borderRadius: "8px", border: "1.5px solid #D1D5DB",
            color: "#4B5563", background: "#fff",
            fontSize: "13px", fontWeight: 500, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      )}

      {/* View mode: Draw button */}
      {adjustMode && interactionMode === "view" && (
        <button
          onClick={() => { setIM("draw"); loadRoomShape(); }}
          style={{
            width: "100%", height: "40px", marginTop: "8px",
            borderRadius: "8px", border: "none",
            background: "#8B1A1A", color: "#fff",
            fontSize: "13px", fontWeight: 600, cursor: "pointer",
          }}
        >
          Draw — {currentRoomName}
        </button>
      )}
    </div>
  );
}
