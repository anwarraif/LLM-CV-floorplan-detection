"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { RoomShape } from "@/components/RoomConfirmCanvas";
import { offsetWallLabels, type MeasurementPlan } from "@/lib/geometry";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

function buildImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = API_URL.replace(/\/$/, "");
  const path = url.startsWith("/") ? url : "/" + url;
  return base + path;
}

const COLORS = {
  filled: {
    fill: "rgba(26,107,60,0.10)",
    stroke: "#1A6B3C",
    label: "rgba(26,107,60,0.18)",
    text: "#1A6B3C",
    area: "#2563EB",
    dim: "#EA580C",
  },
  unfilled: {
    fill: "rgba(163,45,45,0.10)",
    stroke: "#A32D2D",
    label: "rgba(163,45,45,0.13)",
    text: "#A32D2D",
    area: "#2563EB",
    dim: "#EA580C",
  },
  userMarked: {
    fill: "rgba(133,79,11,0.10)",
    stroke: "#854F0B",
    label: "rgba(133,79,11,0.13)",
    text: "#854F0B",
    area: "#2563EB",
    dim: "#EA580C",
  },
} as const;

type BBox = { x: number; y: number; w: number; h: number };

type Room = {
  room_name: string;
  is_balcony: boolean;
  bbox: BBox | null;
  length_m?: number;
  width_m?: number;
  confidence?: number;
  source?: "ai" | "user_marked" | "user_added";
  shape?: RoomShape;
  polygon_points?: Array<{ x: number; y: number }>;
  shape_data?: Record<string, unknown>;
  shape_type?: string;
  shape_mode?: string;
  sides?: Array<string | number>;
  plan?: MeasurementPlan | null;
  planValues?: Record<string, string>;
  measured?: boolean;
};

function getPolygonPoints(room: Room): Array<{ x: number; y: number }> | null {
  const s = room.shape;
  // camelCase from RoomShape (user-drawn)
  if (s?.polygonPoints && s.polygonPoints.length >= 3) return s.polygonPoints;
  // snake_case on shape object (from DB)
  const sp = (s as Record<string, unknown>)?.polygon_points as Array<{ x: number; y: number }> | undefined;
  if (sp && sp.length >= 3) return sp;
  // top-level polygon_points (from AI confirm step)
  if (room.polygon_points && room.polygon_points.length >= 3) return room.polygon_points;
  // shape_data paths (DB-loaded shapes)
  const sd = room.shape_data;
  if (sd?.polygon_points && Array.isArray(sd.polygon_points) && (sd.polygon_points as unknown[]).length >= 3)
    return sd.polygon_points as Array<{ x: number; y: number }>;
  if (sd?.polygonPoints && Array.isArray(sd.polygonPoints) && (sd.polygonPoints as unknown[]).length >= 3)
    return sd.polygonPoints as Array<{ x: number; y: number }>;
  return null;
}

interface Props {
  imageUrl: string;
  rooms: Room[];
  focused?: { room: number; item: string } | null;
  // Task 1: index of the room being measured; only its dimension lines are drawn
  // (unless allMeasured is true, in which case every room's lines are shown).
  activeRoom?: number | null;
  allMeasured?: boolean;
  // OPT-IN height cap, used by Measure so the plan can stay pinned on screen while the stager
  // types. Left undefined (the default) the layout is byte-identical to before — this component
  // is shared with the saved-apartment detail page, which must not change.
  maxHeightPx?: number;
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getPolygonAxes(points: Array<{ x: number; y: number }>, W: number, H: number) {
  if (points.length < 3) return null;
  const px = points.map((p) => p.x * W);
  const py = points.map((p) => p.y * H);

  // Find the longest side (primary axis)
  let maxLen1 = 0;
  let axis1 = { dx: 1, dy: 0 };
  let bestIdx1 = -1;

  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const dx = px[j] - px[i];
    const dy = py[j] - py[i];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > maxLen1) {
      maxLen1 = len;
      axis1 = { dx: dx / len, dy: dy / len };
      bestIdx1 = i;
    }
  }

  // Find the longest side that is NOT parallel to the primary axis (secondary axis)
  let maxLen2 = 0;
  let axis2 = { dx: -axis1.dy, dy: axis1.dx }; // fallback to perpendicular vector

  for (let i = 0; i < points.length; i++) {
    if (i === bestIdx1) continue;
    const j = (i + 1) % points.length;
    const dx = px[j] - px[i];
    const dy = py[j] - py[i];
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len > 0) {
      const udx = dx / len;
      const udy = dy / len;
      // Dot product to check parallelism
      const dot = Math.abs(udx * axis1.dx + udy * axis1.dy);
      // If the side is not parallel (dot product < 0.7, i.e. angle > 45 degrees)
      if (dot < 0.7) {
        if (len > maxLen2) {
          maxLen2 = len;
          axis2 = { dx: udx, dy: udy };
        }
      }
    }
  }

  // Fallback: estimate length if no orthogonal side is found
  if (maxLen2 === 0) {
    const perpAxis = { dx: -axis1.dy, dy: axis1.dx };
    let minProj = Infinity;
    let maxProj = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const proj = px[i] * perpAxis.dx + py[i] * perpAxis.dy;
      if (proj < minProj) minProj = proj;
      if (proj > maxProj) maxProj = proj;
    }
    maxLen2 = maxProj - minProj;
    axis2 = perpAxis;
  }

  return {
    primary:   { axis: axis1, length: maxLen1 },
    secondary: { axis: axis2, length: maxLen2 },
  };
}

function getPolygonCentroid(points: Array<{ x: number; y: number }>, W: number, H: number) {
  const cx = points.reduce((s, p) => s + p.x * W, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y * H, 0) / points.length;
  return { cx, cy };
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string
) {
  const headLen = 8;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - 0.4), y2 - headLen * Math.sin(angle - 0.4));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + 0.4), y2 - headLen * Math.sin(angle + 0.4));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + headLen * Math.cos(angle - 0.4 + Math.PI), y1 + headLen * Math.sin(angle - 0.4 + Math.PI));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + headLen * Math.cos(angle + 0.4 + Math.PI), y1 + headLen * Math.sin(angle + 0.4 + Math.PI));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

export default function FloorPlanCanvas({ imageUrl, rooms, focused, activeRoom = null, allMeasured = false, maxHeightPx }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgElementRef = useRef<HTMLImageElement | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imgError, setImgError] = useState(false);
  const lastTouchDist = useRef<number | null>(null);
  const isDragging = useRef(false);
  const lastPan = useRef({ x: 0, y: 0 });

  const constrainPan = (px: number, py: number, z: number): { x: number; y: number } => {
    const img = imgElementRef.current;
    if (!img || z <= 1) return { x: 0, y: 0 };
    return {
      x: Math.max(-(img.offsetWidth * (z - 1)), Math.min(0, px)),
      y: Math.max(-(img.offsetHeight * (z - 1)), Math.min(0, py)),
    };
  };

  // Draw at 1:1 scale — CSS transform on transformRef handles visual zoom/pan.
  // This ensures canvas and image always stay perfectly aligned at any zoom level.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = imgElementRef.current;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const W = img.offsetWidth;
    const H = img.offsetHeight;
    if (W === 0 || H === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    rooms.forEach((room, roomIdx) => {
      if (!room.bbox) return;
      const { x, y, w, h } = room.bbox;
      const px = x * W;
      const py = y * H;
      const pw = w * W;
      const ph = h * H;
      const cx = px + pw / 2;
      const cy = py + ph / 2;

      const isFilled = room.measured !== undefined
        ? room.measured
        : (room.length_m ?? 0) > 0 && (room.width_m ?? 0) > 0;
      const isUserMarked = room.source === "user_marked" || room.source === "user_added";
      const palette = isFilled ? COLORS.filled : isUserMarked ? COLORS.userMarked : COLORS.unfilled;

      ctx.strokeStyle = palette.stroke;
      ctx.lineWidth = 2;
      if (isUserMarked && !isFilled) ctx.setLineDash([5, 4]);
      else ctx.setLineDash([]);

      const polySource = getPolygonPoints(room);
      const shapeMode = room.shape?.mode || room.shape_mode || room.shape_type;
      console.log(`[Canvas] ${room.room_name}: shape=${shapeMode} pts=${polySource?.length ?? 0}`);

      let labelCx = cx;
      let labelCy = cy;

      if (polySource) {
        const pts = polySource.map((p) => ({ x: p.x * W, y: p.y * H }));
        ctx.beginPath();
        pts.forEach((pt, idx) => { if (idx === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
        ctx.closePath();
        ctx.fillStyle = palette.fill;
        ctx.fill();
        ctx.stroke();
        labelCx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        labelCy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
      } else if (shapeMode === "rotated" &&
          (room.shape?.rotatedRect || (room.shape as Record<string, unknown>)?.rotated_rect || (room.shape_data as Record<string, unknown>)?.rotated_rect)) {
        const rrData = (room.shape?.rotatedRect ?? (room.shape as Record<string, unknown>)?.rotated_rect ?? (room.shape_data as Record<string, unknown>)?.rotated_rect) as { cx: number; cy: number; w: number; h: number; angle: number };
        const { cx: rcx_frac, cy: rcy_frac, w: rw_frac, h: rh_frac, angle } = rrData;
        const rcx = rcx_frac * W;
        const rcy = rcy_frac * H;
        const rw  = rw_frac * W;
        const rh  = rh_frac * H;
        ctx.save();
        ctx.translate(rcx, rcy);
        ctx.rotate(angle);
        ctx.fillStyle = palette.fill;
        ctx.fillRect(-rw / 2, -rh / 2, rw, rh);
        ctx.strokeRect(-rw / 2, -rh / 2, rw, rh);
        ctx.restore();
      } else {
        ctx.fillStyle = palette.fill;
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeRect(px, py, pw, ph);
      }
      ctx.setLineDash([]);

      const fontSize = Math.max(10, Math.min(13, pw * 0.14));

      // Task 1: only draw dimension lines for the room being measured (activeRoom), or
      // for every room once all are measured. Others keep just their outline + label.
      const showLines = allMeasured || roomIdx === activeRoom;

      if (showLines) {
      if (room.plan && room.plan.items && room.plan.items.length > 0) {
        // Phase 3: draw the measurement plan as numbered dimension lines ON the walls,
        // highlighting the segment whose input is focused.
        room.plan.items.forEach((it, i) => {
          const fx = it.from.x * W, fy = it.from.y * H;
          const tx2 = it.to.x * W, ty2 = it.to.y * H;
          const isFocused = !!focused && focused.room === roomIdx && focused.item === it.id;
          const infeasible = it.feasible === false;
          ctx.setLineDash(infeasible && !isFocused ? [6, 4] : []);
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.lineTo(tx2, ty2);
          ctx.strokeStyle = isFocused ? "#2563EB" : infeasible ? "#B45309" : palette.stroke;
          ctx.lineWidth = isFocused ? 4 : 2.5;
          ctx.stroke();
          ctx.setLineDash([]);

          const mx = (fx + tx2) / 2, my = (fy + ty2) / 2;
          const dx = tx2 - fx, dy = ty2 - fy;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          let nx = -dy / len, ny = dx / len;
          if ((mx - labelCx) * nx + (my - labelCy) * ny < 0) { nx = -nx; ny = -ny; }
          const bx = mx + nx * 13, by = my + ny * 13;

          ctx.beginPath();
          ctx.arc(bx, by, 8, 0, Math.PI * 2);
          ctx.fillStyle = isFocused ? "#2563EB" : "#fff";
          ctx.fill();
          ctx.strokeStyle = isFocused ? "#2563EB" : palette.stroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.fillStyle = isFocused ? "#fff" : palette.dim;
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), bx, by);

          const val = room.planValues ? room.planValues[it.id] : undefined;
          if (val && parseFloat(val) > 0) {
            const tvx = mx + nx * 27, tvy = my + ny * 27;
            ctx.font = "bold 9px sans-serif";
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 3;
            ctx.strokeText(`${val}m`, tvx, tvy);
            ctx.fillStyle = palette.dim;
            ctx.fillText(`${val}m`, tvx, tvy);
          }
        });

        // Task 2: for an offsets room, every wall's length is DERIVED (only the baseline is
        // measured directly). Once all values are entered, label each non-baseline wall with
        // its computed length as a subtle grey "~length" so no wall looks unmeasured.
        if (room.plan.recipe && room.plan.recipe.method === "offsets" && room.planValues) {
          const walls = offsetWallLabels(room.plan, room.planValues);
          if (walls) {
            walls.forEach((wl) => {
              if (wl.baseline) return; // baseline already shows its measured value
              const lx = wl.x * W, ly = wl.y * H;
              let ox = lx - labelCx, oy = ly - labelCy;
              const ol = Math.hypot(ox, oy) || 1;
              ox /= ol; oy /= ol;
              const tx = lx + ox * 11, ty = ly + oy * 11;
              const txt = `~${wl.len.toFixed(2)}m`;
              ctx.font = "italic 8px sans-serif";
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 3;
              ctx.strokeText(txt, tx, ty);
              ctx.fillStyle = "#6B7280";
              ctx.fillText(txt, tx, ty);
            });
          }
        }
      } else if (polySource && polySource.length >= 3) {
        const axes = getPolygonAxes(polySource, W, H);
        const { cx: acx, cy: acy } = getPolygonCentroid(polySource, W, H);
        if (axes) {
          const pad = 12;
          const len1 = axes.primary.length / 2 - pad;
          const len2 = axes.secondary.length / 2 - pad;
          if (len1 > 10) {
            const ax1 = axes.primary.axis;
            drawArrow(ctx, acx - ax1.dx * len1, acy - ax1.dy * len1, acx + ax1.dx * len1, acy + ax1.dy * len1, palette.stroke);
            if (room.length_m && room.length_m > 0) {
              ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const tx = acx + ax1.dx * (len1 * 0.5) - ax1.dy * 10;
              const ty = acy + ax1.dy * (len1 * 0.5) + ax1.dx * 10;
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 3;
              ctx.strokeText(`${room.length_m}m`, tx, ty);
              ctx.fillStyle = palette.dim;
              ctx.fillText(`${room.length_m}m`, tx, ty);
            }
          }
          if (len2 > 10) {
            const ax2 = axes.secondary.axis;
            drawArrow(ctx, acx - ax2.dx * len2, acy - ax2.dy * len2, acx + ax2.dx * len2, acy + ax2.dy * len2, palette.stroke);
            if (room.width_m && room.width_m > 0) {
              ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const tx = acx + ax2.dx * (len2 * 0.5) + ax2.dy * 10;
              const ty = acy + ax2.dy * (len2 * 0.5) - ax2.dx * 10;
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 3;
              ctx.strokeText(`${room.width_m}m`, tx, ty);
              ctx.fillStyle = palette.dim;
              ctx.fillText(`${room.width_m}m`, tx, ty);
            }
          }
        }

        // Draw individual side lengths on each segment edge
        if (room.sides && room.sides.length > 0) {
          const pts = polySource.map((p) => ({ x: p.x * W, y: p.y * H }));
          pts.forEach((pt, idx) => {
            const nextPt = pts[(idx + 1) % pts.length];
            const sideVal = room.sides?.[idx];
            const numVal = parseFloat(typeof sideVal === "string" ? sideVal : String(sideVal || ""));

            if (!isNaN(numVal) && numVal > 0) {
              const mx = (pt.x + nextPt.x) / 2;
              const my = (pt.y + nextPt.y) / 2;

              const dx = nextPt.x - pt.x;
              const dy = nextPt.y - pt.y;
              const len = Math.sqrt(dx * dx + dy * dy);

              if (len > 0) {
                const nx = -dy / len;
                const ny = dx / len;

                const vx = mx - acx;
                const vy = my - acy;
                const dot = vx * nx + vy * ny;
                const sign = dot >= 0 ? 1 : -1;

                const ox = nx * sign;
                const oy = ny * sign;

                const tx = mx + ox * 12;
                const ty = my + oy * 12;

                ctx.save();
                ctx.font = `bold ${Math.max(8.5, fontSize * 0.85)}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 3;
                ctx.strokeText(`${numVal}m`, tx, ty);
                ctx.fillStyle = palette.dim;
                ctx.fillText(`${numVal}m`, tx, ty);
                ctx.restore();
              }
            }
          });
        }
      } else {
        const pad = Math.max(8, pw * 0.08);
        if (pw > 24) drawArrow(ctx, px + pad, cy, px + pw - pad, cy, palette.stroke);
        if (ph > 24) drawArrow(ctx, cx, py + pad, cx, py + ph - pad, palette.stroke);
        if (room.length_m && room.length_m > 0 && ph > 30) {
          ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tx = cx - 10;
          const ty = cy + (ph / 2 - pad) * 0.5;
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3;
          ctx.strokeText(`${room.length_m}m`, tx, ty);
          ctx.fillStyle = palette.dim;
          ctx.fillText(`${room.length_m}m`, tx, ty);
        }
        if (room.width_m && room.width_m > 0 && pw > 30) {
          ctx.save();
          const tx = cx + (pw / 2 - pad) * 0.5;
          const ty = cy - 10;
          ctx.translate(tx, ty);
          ctx.rotate(-Math.PI / 2);
          ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3;
          ctx.strokeText(`${room.width_m}m`, 0, 0);
          ctx.fillStyle = palette.dim;
          ctx.fillText(`${room.width_m}m`, 0, 0);
          ctx.restore();
        }
      }
      } // end showLines gate (Task 1: per-room dimension-line reveal)
      if (ph > 30) {
        ctx.font = `bold ${fontSize}px sans-serif`;
        const labelW = Math.min(pw - 6, ctx.measureText(room.room_name).width + 8);
        const labelH = fontSize + 4;
        const rx = 3;
        const lx = labelCx - labelW / 2;
        const ly = labelCy + 3;
        ctx.fillStyle = palette.label;
        drawRoundRect(ctx, lx, ly, labelW, labelH, rx);
        ctx.fill();
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = palette.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(room.room_name, labelCx, ly + labelH / 2);
      }
      if (isFilled && room.length_m && room.width_m && ph > 50) {
        const area = (room.length_m * room.width_m).toFixed(1);
        ctx.font = `bold ${Math.max(7.5, fontSize * 0.9)}px sans-serif`;
        ctx.fillStyle = palette.area;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`${area} m²`, labelCx, labelCy + fontSize * 1.8);
      }
    });

    ctx.restore();
  }, [rooms, focused, activeRoom, allMeasured]);

  useEffect(() => { drawRef.current = draw; }, [draw]);
  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => drawRef.current?.());
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(4, Math.max(1, z - e.deltaY * 0.001)));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const handleResize = () => { setTimeout(() => drawRef.current?.(), 100); };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
    }
    if (e.touches.length === 1) {
      isDragging.current = true;
      lastPan.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const delta = dist - lastTouchDist.current;
      lastTouchDist.current = dist;
      setZoom((z) => Math.min(4, Math.max(1, z + delta * 0.005)));
    }
    if (e.touches.length === 1 && isDragging.current && zoom > 1) {
      const dx = e.touches[0].clientX - lastPan.current.x;
      const dy = e.touches[0].clientY - lastPan.current.y;
      lastPan.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setPan((p) => constrainPan(p.x + dx, p.y + dy, zoom));
    }
  };

  const onTouchEnd = () => {
    lastTouchDist.current = null;
    isDragging.current = false;
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return;
    isDragging.current = true;
    lastPan.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current || zoom <= 1) return;
    const dx = e.clientX - lastPan.current.x;
    const dy = e.clientY - lastPan.current.y;
    lastPan.current = { x: e.clientX, y: e.clientY };
    setPan((p) => constrainPan(p.x + dx, p.y + dy, zoom));
  };
  const onMouseUp = () => { isDragging.current = false; };

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        minHeight: maxHeightPx ? undefined : "220px",
        display: maxHeightPx ? "flex" : undefined,
        justifyContent: maxHeightPx ? "center" : undefined,
        borderRadius: "8px",
        overflow: "hidden",
        lineHeight: 0,
        touchAction: zoom > 1 ? "none" : "auto",
        cursor: zoom > 1 ? "grab" : "default",
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Image + canvas share this transformed div so they always move together */}
      <div
        ref={transformRef}
        style={{
          transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
          transformOrigin: "0 0",
          position: "relative",
          width: maxHeightPx ? "fit-content" : "100%",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgElementRef}
          src={buildImageUrl(imageUrl)}
          alt="Floor plan"
          onLoad={() => { setImgError(false); setTimeout(() => draw(), 50); }}
          onError={() => {
            console.error(`[FloorPlanCanvas] Failed to load: ${buildImageUrl(imageUrl)}`);
            setImgError(true);
          }}
          style={{
            width: maxHeightPx ? "auto" : "100%",
            maxWidth: "100%",
            maxHeight: maxHeightPx ? `${maxHeightPx}px` : undefined,
            display: imgError ? "none" : "block",
            borderRadius: "8px",
          }}
        />
        {imgError && (
          <div style={{
            padding: "20px", textAlign: "center", color: "#A32D2D",
            background: "#FEF2F2", borderRadius: "8px",
          }}>
            <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Could not load floor plan image.</p>
            <p style={{ margin: 0, fontSize: "11px", opacity: 0.7, wordBreak: "break-all" }}>
              {buildImageUrl(imageUrl)}
            </p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          aria-label="Floor plan with room overlay and measurement lines"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            borderRadius: "8px",
          }}
        />
      </div>

      {/* Controls outside the transform layer so they stay fixed in corner */}
      {zoom > 1 && (
        <button
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
          aria-label="Reset zoom"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 100,
            background: "#8B1A1A",
            color: "#fff",
            border: "none",
            borderRadius: "8px",
            padding: "8px 12px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
            minHeight: "44px",
          }}
        >
          ↺ {Math.round(zoom * 100)}%
        </button>
      )}
      {zoom > 1 && (
        <div style={{
          position: "absolute",
          bottom: 8,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          borderRadius: "20px",
          padding: "5px 14px",
          fontSize: "12px",
          pointerEvents: "none",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        }}>
          ✋ Drag to pan
        </div>
      )}
      {zoom === 1 && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.45)",
            color: "#fff",
            borderRadius: "20px",
            padding: "4px 12px",
            fontSize: "11px",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          🔍 Pinch or scroll to zoom
        </div>
      )}
    </div>
  );
}
