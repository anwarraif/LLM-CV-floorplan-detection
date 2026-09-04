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
  sides?: Array<string | number>;
  plan?: MeasurementPlan | null;
  planValues?: Record<string, string>;
  measured?: boolean;
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  rooms: Room[];
  // Task 1: index of the room being measured; only its dimension lines are drawn
  // (unless allMeasured is true, in which case every room's lines are shown).
  activeRoom?: number | null;
  allMeasured?: boolean;
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
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

function getPolygonAxes(points: Array<{ x: number; y: number }>, W: number, H: number, baseX: number, baseY: number) {
  if (points.length < 3) return null;
  const px = points.map((p) => baseX + p.x * W);
  const py = points.map((p) => baseY + p.y * H);

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

  const cx = px.reduce((s, v) => s + v, 0) / px.length;
  const cy = py.reduce((s, v) => s + v, 0) / py.length;

  return {
    primary:   { axis: axis1, length: maxLen1 },
    secondary: { axis: axis2, length: maxLen2 },
    cx, cy,
  };
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  color: string, zoom: number
) {
  const headLen = Math.max(8, 8 / zoom);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - 0.4), y2 - headLen * Math.sin(angle - 0.4));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle + 0.4), y2 - headLen * Math.sin(angle + 0.4));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + headLen * Math.cos(angle - 0.4 + Math.PI), y1 + headLen * Math.sin(angle - 0.4 + Math.PI));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + headLen * Math.cos(angle + 0.4 + Math.PI), y1 + headLen * Math.sin(angle + 0.4 + Math.PI));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / zoom;
  ctx.stroke();
}

export default function FloorPlanViewer({ isOpen, onClose, imageUrl, rooms, activeRoom = null, allMeasured = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgObj, setImgObj] = useState<HTMLImageElement | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const isDragging = useRef(false);
  const lastPan = useRef({ x: 0, y: 0 });

  // Constrain pan so user can't drag the image completely off screen
  const constrainPan = (px: number, py: number, z: number, containerW: number, containerH: number): { x: number; y: number } => {
    if (z <= 1) return { x: 0, y: 0 };
    const maxX = containerW * (z - 1) / 2;
    const maxY = containerH * (z - 1) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, px)),
      y: Math.max(-maxY, Math.min(maxY, py)),
    };
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = imgObj;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const containerW = container.offsetWidth;
    const containerH = container.offsetHeight;
    if (containerW === 0 || containerH === 0) return;

    const naturalAspect = img.naturalHeight / img.naturalWidth;
    // Fit image within container, keeping aspect ratio
    let drawW = containerW;
    let drawH = containerW * naturalAspect;
    if (drawH > containerH) {
      drawH = containerH;
      drawW = containerH / naturalAspect;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width  = containerW * dpr;
    canvas.height = containerH * dpr;
    canvas.style.width  = containerW + "px";
    canvas.style.height = containerH + "px";

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);  // all drawing now in CSS pixels
    ctx.save();

    // Centre the image then apply zoom/pan from centre
    const offsetX = (containerW - drawW) / 2;
    const offsetY = (containerH - drawH) / 2;

    ctx.translate(containerW / 2 + pan.x, containerH / 2 + pan.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-containerW / 2, -containerH / 2);

    // Draw the image
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

    const W = drawW;
    const H = drawH;
    const baseX = offsetX;
    const baseY = offsetY;

    rooms.forEach((room, roomIdx) => {
      if (!room.bbox) return;
      const { x, y, w, h } = room.bbox;
      const px = baseX + x * W;
      const py = baseY + y * H;
      const pw = w * W;
      const ph = h * H;
      const cx = px + pw / 2;  // bbox center — used for arrows
      const cy = py + ph / 2;

      const isFilled = room.measured !== undefined
        ? room.measured
        : (room.length_m ?? 0) > 0 && (room.width_m ?? 0) > 0;
      const isUserMarked = room.source === "user_marked" || room.source === "user_added";
      const palette = isFilled ? COLORS.filled : isUserMarked ? COLORS.userMarked : COLORS.unfilled;

      ctx.strokeStyle = palette.stroke;
      ctx.lineWidth = Math.max(2, 2.5 / zoom);
      if (isUserMarked && !isFilled) ctx.setLineDash([5 / zoom, 4 / zoom]);
      else ctx.setLineDash([]);

      const s = room.shape;

      // Resolve polygon points from any available source
      const polySource: Array<{ x: number; y: number }> | null = (() => {
        if (s?.polygonPoints && s.polygonPoints.length >= 3) return s.polygonPoints;
        const sp = (s as Record<string, unknown>)?.polygon_points as Array<{ x: number; y: number }> | undefined;
        if (sp && sp.length >= 3) return sp;
        if (room.polygon_points && room.polygon_points.length >= 3) return room.polygon_points;
        return null;
      })();

      let labelCx = cx;
      let labelCy = cy;

      if (polySource) {
        const pts = polySource.map((p) => ({ x: baseX + p.x * W, y: baseY + p.y * H }));
        ctx.beginPath();
        pts.forEach((pt, idx) => { if (idx === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
        ctx.closePath();
        ctx.fillStyle = palette.fill;
        ctx.fill();
        ctx.stroke();
        labelCx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        labelCy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
      } else if (s?.mode === "rotated" && s.rotatedRect) {
        const { cx: rcx_frac, cy: rcy_frac, w: rw_frac, h: rh_frac, angle } = s.rotatedRect;
        const rcx = baseX + rcx_frac * W;
        const rcy = baseY + rcy_frac * H;
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

      const fontSize = Math.max(10, Math.min(13, pw * 0.14)) / zoom;

      // Task 1: only draw dimension lines for the room being measured (activeRoom), or
      // for every room once all are measured. Others keep just their outline + label.
      const showLines = allMeasured || roomIdx === activeRoom;

      if (showLines) {
      if (room.plan && room.plan.items && room.plan.items.length > 0) {
        // Phase 3: numbered dimension lines on the walls (matches the Measure checklist).
        room.plan.items.forEach((it, i) => {
          const fx = baseX + it.from.x * W, fy = baseY + it.from.y * H;
          const tx2 = baseX + it.to.x * W, ty2 = baseY + it.to.y * H;
          const infeasible = it.feasible === false;
          ctx.setLineDash(infeasible ? [6 / zoom, 4 / zoom] : []);
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.lineTo(tx2, ty2);
          ctx.strokeStyle = infeasible ? "#B45309" : palette.stroke;
          ctx.lineWidth = Math.max(2, 2.5 / zoom);
          ctx.stroke();
          ctx.setLineDash([]);

          const mx = (fx + tx2) / 2, my = (fy + ty2) / 2;
          const dx = tx2 - fx, dy = ty2 - fy;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          let nx = -dy / len, ny = dx / len;
          if ((mx - labelCx) * nx + (my - labelCy) * ny < 0) { nx = -nx; ny = -ny; }
          const bx = mx + nx * (13 / zoom), by = my + ny * (13 / zoom);

          ctx.beginPath();
          ctx.arc(bx, by, 8 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.strokeStyle = palette.stroke;
          ctx.lineWidth = 1.5 / zoom;
          ctx.stroke();
          ctx.fillStyle = palette.dim;
          ctx.font = `bold ${9 / zoom}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), bx, by);

          const val = room.planValues ? room.planValues[it.id] : undefined;
          if (val && parseFloat(val) > 0) {
            const tvx = mx + nx * (27 / zoom), tvy = my + ny * (27 / zoom);
            ctx.font = `bold ${9 / zoom}px sans-serif`;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 3 / zoom;
            ctx.strokeText(`${val}m`, tvx, tvy);
            ctx.fillStyle = palette.dim;
            ctx.fillText(`${val}m`, tvx, tvy);
          }
        });

        // Task 2: label each non-baseline wall of an offsets room with its DERIVED length
        // (subtle grey "~length") once all values are entered, so no wall looks unmeasured.
        if (room.plan.recipe && room.plan.recipe.method === "offsets" && room.planValues) {
          const walls = offsetWallLabels(room.plan, room.planValues);
          if (walls) {
            walls.forEach((wl) => {
              if (wl.baseline) return;
              const lx = baseX + wl.x * W, ly = baseY + wl.y * H;
              let ox = lx - labelCx, oy = ly - labelCy;
              const ol = Math.hypot(ox, oy) || 1;
              ox /= ol; oy /= ol;
              const tx = lx + ox * (11 / zoom), ty = ly + oy * (11 / zoom);
              const txt = `~${wl.len.toFixed(2)}m`;
              ctx.font = `italic ${8 / zoom}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 3 / zoom;
              ctx.strokeText(txt, tx, ty);
              ctx.fillStyle = "#6B7280";
              ctx.fillText(txt, tx, ty);
            });
          }
        }
      } else if (polySource && polySource.length >= 3) {
        const polyAxes = getPolygonAxes(polySource, W, H, baseX, baseY);
        if (polyAxes) {
          const { primary, secondary, cx: acx, cy: acy } = polyAxes;
          const pad = 12 / zoom;
          const len1 = primary.length / 2 - pad;
          const len2 = secondary.length / 2 - pad;
          if (len1 > 10 / zoom) {
            const ax1 = primary.axis;
            drawArrow(ctx, acx - ax1.dx * len1, acy - ax1.dy * len1, acx + ax1.dx * len1, acy + ax1.dy * len1, palette.stroke, zoom);
            if (room.length_m && room.length_m > 0) {
              ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const tx = acx + ax1.dx * (len1 * 0.5) - ax1.dy * 10 / zoom;
              const ty = acy + ax1.dy * (len1 * 0.5) + ax1.dx * 10 / zoom;
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 3 / zoom;
              ctx.strokeText(`${room.length_m}m`, tx, ty);
              ctx.fillStyle = palette.dim;
              ctx.fillText(`${room.length_m}m`, tx, ty);
            }
          }
          if (len2 > 10 / zoom) {
            const ax2 = secondary.axis;
            drawArrow(ctx, acx - ax2.dx * len2, acy - ax2.dy * len2, acx + ax2.dx * len2, acy + ax2.dy * len2, palette.stroke, zoom);
            if (room.width_m && room.width_m > 0) {
              ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const tx = acx + ax2.dx * (len2 * 0.5) + ax2.dy * 10 / zoom;
              const ty = acy + ax2.dy * (len2 * 0.5) - ax2.dx * 10 / zoom;
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 3 / zoom;
              ctx.strokeText(`${room.width_m}m`, tx, ty);
              ctx.fillStyle = palette.dim;
              ctx.fillText(`${room.width_m}m`, tx, ty);
            }
          }
        }

        // Draw individual side lengths on each segment edge
        const roomSides = room.sides || (room.shape_data?.sides as Array<number | string> | undefined);
        if (roomSides && roomSides.length > 0) {
          const pts = polySource.map((p) => ({ x: baseX + p.x * W, y: baseY + p.y * H }));
          pts.forEach((pt, idx) => {
            const nextPt = pts[(idx + 1) % pts.length];
            const sideVal = roomSides?.[idx];
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

                // Center of mass (centroid) in CSS coordinates
                const acx = polyAxes ? polyAxes.cx : (pts.reduce((sum, p) => sum + p.x, 0) / pts.length);
                const acy = polyAxes ? polyAxes.cy : (pts.reduce((sum, p) => sum + p.y, 0) / pts.length);

                const vx = mx - acx;
                const vy = my - acy;
                const dot = vx * nx + vy * ny;
                const sign = dot >= 0 ? 1 : -1;

                const ox = nx * sign;
                const oy = ny * sign;

                const tx = mx + ox * 12 / zoom;
                const ty = my + oy * 12 / zoom;

                ctx.save();
                ctx.font = `bold ${Math.max(8.5, fontSize * 0.85)}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 3 / zoom;
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
        if (pw > 24 / zoom) drawArrow(ctx, px + pad, cy, px + pw - pad, cy, palette.stroke, zoom);
        if (ph > 24 / zoom) drawArrow(ctx, cx, py + pad, cx, py + ph - pad, palette.stroke, zoom);
        if (room.length_m && room.length_m > 0 && ph > 30 / zoom) {
          ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const tx = cx - 10 / zoom;
          const ty = cy + (ph / 2 - pad) * 0.5;
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3 / zoom;
          ctx.strokeText(`${room.length_m}m`, tx, ty);
          ctx.fillStyle = palette.dim;
          ctx.fillText(`${room.length_m}m`, tx, ty);
        }
        if (room.width_m && room.width_m > 0 && pw > 30 / zoom) {
          ctx.save();
          const tx = cx + (pw / 2 - pad) * 0.5;
          const ty = cy - 10 / zoom;
          ctx.translate(tx, ty);
          ctx.rotate(-Math.PI / 2);
          ctx.font = `bold ${Math.max(7.5, fontSize * 0.85)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3 / zoom;
          ctx.strokeText(`${room.width_m}m`, 0, 0);
          ctx.fillStyle = palette.dim;
          ctx.fillText(`${room.width_m}m`, 0, 0);
          ctx.restore();
        }
      }
      } // end showLines gate (Task 1: per-room dimension-line reveal)
      if (ph > 30 / zoom) {
        ctx.font = `bold ${fontSize}px sans-serif`;
        const labelW = Math.min(pw - 6 / zoom, ctx.measureText(room.room_name).width + 8 / zoom);
        const labelH = fontSize + 4 / zoom;
        const rx = 3 / zoom;
        const lx = labelCx - labelW / 2;
        const ly = labelCy + 3 / zoom;
        ctx.fillStyle = palette.label;
        drawRoundRect(ctx, lx, ly, labelW, labelH, rx);
        ctx.fill();
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = palette.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(room.room_name, labelCx, ly + labelH / 2);
      }
      if (isFilled && room.length_m && room.width_m && ph > 50 / zoom) {
        const area = (room.length_m * room.width_m).toFixed(1);
        ctx.font = `bold ${Math.max(7.5, fontSize * 0.9)}px sans-serif`;
        ctx.fillStyle = palette.area;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`${area} m²`, labelCx, labelCy + fontSize * 1.8);
      }
    });

    ctx.restore();
  }, [rooms, zoom, pan, imgObj, activeRoom, allMeasured]);

  useEffect(() => { drawRef.current = draw; }, [draw]);
  useEffect(() => { draw(); }, [draw]);

  // Load image when viewer opens
  useEffect(() => {
    if (!isOpen) {
      setImgObj(null);
      return;
    }
    const img = new Image();
    img.onload = () => { setImgObj(img); };
    img.src = buildImageUrl(imageUrl);
  }, [isOpen, imageUrl]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => drawRef.current?.());
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Reset zoom/pan when opening
  useEffect(() => {
    if (isOpen) { setZoom(1); setPan({ x: 0, y: 0 }); }
  }, [isOpen]);

  // Lock body scroll while viewer is open so page doesn't shift beneath it
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
    } else {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
    };
  }, [isOpen]);

  // Scroll zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(5, Math.max(1, z - e.deltaY * 0.002)));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
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
      setZoom((z) => Math.min(5, Math.max(1, z + (dist - lastTouchDist.current!) * 0.005)));
      lastTouchDist.current = dist;
    }
    if (e.touches.length === 1 && isDragging.current && zoom > 1) {
      const dx = e.touches[0].clientX - lastPan.current.x;
      const dy = e.touches[0].clientY - lastPan.current.y;
      lastPan.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      const cW = containerRef.current?.offsetWidth ?? 0;
      const cH = containerRef.current?.offsetHeight ?? 0;
      setPan((p) => constrainPan(p.x + dx, p.y + dy, zoom, cW, cH));
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
    if (!isDragging.current) return;
    const dx = e.clientX - lastPan.current.x;
    const dy = e.clientY - lastPan.current.y;
    lastPan.current = { x: e.clientX, y: e.clientY };
    const cW = containerRef.current?.offsetWidth ?? 0;
    const cH = containerRef.current?.offsetHeight ?? 0;
    setPan((p) => constrainPan(p.x + dx, p.y + dy, zoom, cW, cH));
  };
  const onMouseUp = () => { isDragging.current = false; };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "#1a1a1a",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", flexShrink: 0,
        background: "rgba(0,0,0,0.4)",
      }}>
        <span style={{ color: "#fff", fontSize: "15px", fontWeight: 600 }}>Floor Plan</span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Zoom controls */}
          <button
            onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))}
            style={zoomBtnStyle}
            aria-label="Zoom out"
          >−</button>
          <span style={{ color: "#fff", fontSize: "13px", minWidth: "42px", textAlign: "center" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(5, +(z + 0.25).toFixed(2)))}
            style={zoomBtnStyle}
            aria-label="Zoom in"
          >+</button>
          {/* Close */}
          <button
            onClick={onClose}
            style={{ ...zoomBtnStyle, marginLeft: "8px", minWidth: "44px" }}
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          cursor: zoom > 1 ? "grab" : "default",
          touchAction: "none",
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
          aria-label="Full screen floor plan"
        />
        {zoom === 1 && (
          <div style={{
            position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.5)", color: "#fff", borderRadius: "20px",
            padding: "5px 14px", fontSize: "12px", pointerEvents: "none", whiteSpace: "nowrap",
          }}>
            🔍 Pinch or scroll to zoom
          </div>
        )}
        {zoom > 1 && (
          <div style={{
            position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.55)", color: "#fff", borderRadius: "20px",
            padding: "5px 14px", fontSize: "12px", pointerEvents: "none", whiteSpace: "nowrap",
            display: "flex", alignItems: "center", gap: "6px",
          }}>
            ✋ Drag to pan
          </div>
        )}
        {zoom > 1 && (
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            style={{
              position: "absolute", bottom: 16, right: 16,
              background: "#8B1A1A", color: "#fff", border: "none",
              borderRadius: "8px", padding: "8px 16px", fontSize: "13px",
              fontWeight: 600, cursor: "pointer", minHeight: 44,
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            ↺ Reset zoom ({Math.round(zoom * 100)}%)
          </button>
        )}
      </div>
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  minHeight: "36px", minWidth: "36px",
  background: "rgba(255,255,255,0.12)", border: "none",
  borderRadius: "6px", color: "#fff", cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: "18px", fontWeight: 500,
};
