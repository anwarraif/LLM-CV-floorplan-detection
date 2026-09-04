"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import ProgressBar from "@/components/ProgressBar";
import FloorPlanCanvas from "@/components/FloorPlanCanvas";
import FloorPlanViewer from "@/components/FloorPlanViewer";
import type { RoomShape } from "@/components/RoomConfirmCanvas";
import { getMeasurementPlan } from "@/lib/api";
import { computeArea, planComplete, closureGap, type MeasurementPlan } from "@/lib/geometry";

type BBox = { x: number; y: number; w: number; h: number };

interface ReviewRoom {
  room_name: string;
  is_balcony: boolean;
  confidence: number;
  bbox: BBox | null;
  source: "ai" | "user_marked" | "user_added";
  sort_order: number;
  shape?: RoomShape;
  polygon_points?: Array<{ x: number; y: number }>;
}

type Measurement = {
  length_m: string;
  width_m: string;
  area_m2: string;
  sides?: string[];
};

// A measurement value may be a sum of parts (measured around a pillar), e.g. "2+0.1+1.9".
function evalSum(v: string | number | undefined | null): number {
  if (typeof v === "number") return v;
  if (!v) return 0;
  return String(v).split("+").reduce((s, p) => s + (parseFloat(p) || 0), 0);
}
// Blank inputs are OMITTED, never coerced to 0 — an offset of 0 is a legitimate measurement
// (a corner on the baseline wall), so an empty field must stay distinguishable from a typed 0.
function evalVals(obj?: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || String(v).trim() === "") continue;
    out[k] = evalSum(v);
  }
  return out;
}

function parseArea(length_m: string, width_m: string): number | null {
  const l = parseFloat(length_m);
  const w = parseFloat(width_m);
  if (!isNaN(l) && !isNaN(w) && l > 0 && w > 0) return Math.round(l * w * 100) / 100;
  return null;
}

// Resolve the polygon the measurement plan is built from.
//
// Rooms drawn in Review as a plain or rotated rectangle carry NO polygonPoints
// (RoomConfirmCanvas emits {mode:"rectangle"} / {mode:"rotated", rotatedRect}), and a room the
// AI only boxed carries just a bbox — all of which used to be structurally unable to get a plan.
// Deriving a 4-point polygon for them lets the SAME backend path measure them: the engine
// classifies a 4-point right-angled polygon as rectangle/rotated_rectangle and returns the
// two-item `product` recipe, so the area stays backend-authoritative and the canvas gets real
// dimension lines. Points are emitted clockwise from the top-left so "Wall 1 (top)" is the top wall.
function getRoomPolygonPoints(room: any, ar: number = 1): Array<{ x: number; y: number }> | null {
  const s = room.shape;
  if (s?.polygonPoints && s.polygonPoints.length >= 3) return s.polygonPoints;
  const sp = s?.polygon_points as Array<{ x: number; y: number }> | undefined;
  if (sp && sp.length >= 3) return sp;
  if (room.polygon_points && room.polygon_points.length >= 3) return room.polygon_points;

  const a = ar > 0 ? ar : 1;
  const rr = s?.rotatedRect || (s as Record<string, unknown> | undefined)?.rotated_rect as
    { cx: number; cy: number; w: number; h: number; angle: number } | undefined;
  if (rr && rr.w > 0 && rr.h > 0) {
    // Rotate in aspect-corrected space (the same space the canvas rotates in), then convert back.
    const cx = rr.cx * a, cy = rr.cy, hw = (rr.w * a) / 2, hh = rr.h / 2;
    const cos = Math.cos(rr.angle), sin = Math.sin(rr.angle);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
      x: (cx + lx * cos - ly * sin) / a,
      y: cy + lx * sin + ly * cos,
    }));
  }

  const b = room.bbox as { x: number; y: number; w: number; h: number } | null | undefined;
  if (b && b.w > 0 && b.h > 0) {
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ];
  }
  return null;
}

function calculatePolygonMeasurements(
  pts: Array<{ x: number; y: number }>,
  sides: string[],
  aspectRatio: number
) {
  const n = pts.length;
  const relLengths = pts.map((p, i) => {
    const nextP = pts[(i + 1) % n];
    const dx = (nextP.x - p.x) * aspectRatio;
    const dy = nextP.y - p.y;
    return Math.sqrt(dx * dx + dy * dy);
  });

  const scales: number[] = [];
  sides.forEach((val, i) => {
    const len = parseFloat(val);
    if (!isNaN(len) && len > 0) {
      scales.push(len / relLengths[i]);
    }
  });

  if (scales.length === 0) {
    return { area: null, estSideLengths: [] };
  }

  const avgScale = scales.reduce((s, x) => s + x, 0) / scales.length;
  const estSideLengths = relLengths.map(rel => Math.round(rel * avgScale * 100) / 100);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    sum += curr.x * aspectRatio * next.y - next.x * aspectRatio * curr.y;
  }
  const normArea = 0.5 * Math.abs(sum);
  const realArea = Math.round(normArea * avgScale * avgScale * 100) / 100;

  return { area: realArea, estSideLengths };
}

// Why a room has no measurement plan. Each maps to a distinct, actionable message.
type PlanIssue = "no_geometry" | "unsupported" | "error";

const DRAFT_KEY = "plan_values_draft";
const DRAFT_VERSION = 2;

type DraftEnvelope = {
  v: number;
  scope: string;
  rooms: Record<string, { sig: string; values: Record<string, string> }>;
};

// Identity of a plan for the purpose of reusing typed values: the shape class plus every item's
// id, kind and wall endpoints. Item ids alone are NOT identity — they are loop indices, so `m0`
// denotes a different wall after a polygon edit. Restoring by id would silently rebind a laser
// reading to another wall and the backend would then recompute that as authoritative area.
function planSignature(plan: MeasurementPlan): string {
  return (
    plan.shape_class +
    "|" +
    plan.items
      .map(
        (i) =>
          `${i.id}:${i.kind}:${i.from.x.toFixed(4)},${i.from.y.toFixed(4)}>${i.to.x.toFixed(4)},${i.to.y.toFixed(4)}`
      )
      .join(";")
  );
}

export default function MeasurePage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<ReviewRoom[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<Record<number, Measurement>>({});
  const [viewerOpen, setViewerOpen] = useState(false);
  const [imgAspectRatio, setImgAspectRatio] = useState(1);
  // The plan MUST NOT be requested until the real aspect ratio is known. Planning at the
  // placeholder 1.0 produces a different recipe and a disjoint item-id set for rotated rooms
  // (e.g. rotated rectangle: product/2 items -> trapezoid/3), and doubles the request load.
  const [arReady, setArReady] = useState(false);
  // Phase 3: guided measurement plans (per room) and the values the stager enters (per item)
  const [plans, setPlans] = useState<Record<number, MeasurementPlan | null>>({});
  // False until the plan request has settled. Distinguishes "not fetched yet" from "no plan",
  // so a room in flight never renders measurement inputs of any kind.
  const [plansLoaded, setPlansLoaded] = useState(false);
  // WHY a room has no plan. A room without a plan is BLOCKED with a stated reason and a way out —
  // it is never silently handed a different measurement model.
  const [planIssues, setPlanIssues] = useState<Record<number, PlanIssue>>({});
  const [retrying, setRetrying] = useState<Record<number, boolean>>({});
  // Rooms whose stored values were discarded because their shape changed in Review.
  const [staleRooms, setStaleRooms] = useState<number[]>([]);
  const restoredRef = useRef(false);
  // Accordion: exactly one room expanded at a time. Single-open is what makes `activeRoom`
  // unambiguous — the canvas can highlight one room's dimension lines, not two.
  const [openRoom, setOpenRoom] = useState<number | null>(null);
  const didInitOpenRef = useRef(false);
  // Height cap for the pinned plan, derived from the viewport rather than a fixed pixel guess:
  // ~34% leaves roughly 360px for inputs on a 390x844 phone, so a room card still fits under it.
  const [canvasMaxH, setCanvasMaxH] = useState<number | undefined>(undefined);
  useEffect(() => {
    const compute = () => setCanvasMaxH(Math.round(Math.min(260, window.innerHeight * 0.34)));
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  useEffect(() => {
    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, []);

  const [planValues, setPlanValues] = useState<Record<number, Record<string, string>>>({});
  const [focused, setFocused] = useState<{ room: number; item: string } | null>(null);
  // Task 1: the room currently being measured (last input focused). Unlike `focused`
  // it is NOT cleared on blur, so its dimension lines stay on the canvas while typing.
  const [activeRoom, setActiveRoom] = useState<number | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!imageUrl) { setArReady(true); return; }   // nothing to measure the ratio from
    let settled = false;
    const settle = (ar?: number) => {
      if (settled) return;
      settled = true;
      if (ar && ar > 0) setImgAspectRatio(ar);
      setArReady(true);
    };
    const img = new Image();
    img.onload = () => settle(img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : undefined);
    img.onerror = () => settle();                       // keep the page usable; canvas shows its own error
    const watchdog = setTimeout(() => settle(), 8000);  // bound the wait so the page can never hang
    img.src = imageUrl;
    return () => { settled = true; clearTimeout(watchdog); };
  }, [imageUrl]);

  // Phase 3: fetch the guided measurement plan for each polygon room from the backend
  // (single source of truth for classification and the area recipe).
  useEffect(() => {
    if (!rooms.length || !arReady) return;   // never plan at a guessed aspect ratio
    let cancelled = false;
    setPlansLoaded(false);
    (async () => {
      const next: Record<number, MeasurementPlan | null> = {};
      const issues: Record<number, PlanIssue> = {};
      await Promise.all(
        rooms.map(async (room, idx) => {
          const pts = getRoomPolygonPoints(room, imgAspectRatio);
          if (!pts || pts.length < 3) { next[idx] = null; issues[idx] = "no_geometry"; return; }
          // One bounded retry: the observed /measurement-plan failure is a short DB blip, and a
          // retry turns most of them into a spinner instead of a degraded measurement model.
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const plan = await getMeasurementPlan(pts, imgAspectRatio);
              if (plan && plan.supported) next[idx] = plan;
              else { next[idx] = null; issues[idx] = "unsupported"; }
              return;
            } catch {
              if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
              else { next[idx] = null; issues[idx] = "error"; }
            }
          }
        })
      );
      if (!cancelled) { setPlans(next); setPlanIssues(issues); setPlansLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [rooms, imgAspectRatio, arReady]);

  useEffect(() => {
    const raw = sessionStorage.getItem("review_result");
    if (!raw) { router.replace("/review"); return; }
    try {
      const data = JSON.parse(raw);
      console.log("[Measure] image_url:", data.image_url);
      console.log("[Measure] upload_id:", data.upload_id);
      const loadedRooms = (data.rooms || []) as ReviewRoom[];
      setRooms(loadedRooms);
      setImageUrl(data.image_url || null);
      const draft = sessionStorage.getItem("measurements_draft");
      const saved: Record<number, any> = draft ? JSON.parse(draft) : {};
      const init: Record<number, Measurement> = {};

      loadedRooms.forEach((_, idx) => {
        const room = loadedRooms[idx];
        const pts = getRoomPolygonPoints(room);
        const numSides = pts ? pts.length : 0;

        if (saved[idx]) {
          init[idx] = {
            length_m: saved[idx].length_m || "",
            width_m: saved[idx].width_m || "",
            area_m2: saved[idx].area_m2 !== undefined ? saved[idx].area_m2 : (parseArea(saved[idx].length_m, saved[idx].width_m)?.toString() || ""),
            sides: saved[idx].sides || (numSides > 0 ? Array(numSides).fill("") : undefined)
          };
        } else {
          const roomShapeData = (loadedRooms[idx] as any)?.shape;
          const dbSides = roomShapeData?.sides;
          const initialSides = dbSides && Array.isArray(dbSides)
            ? dbSides.map((val: any) => val ? val.toString() : "")
            : (numSides > 0 ? Array(numSides).fill("") : undefined);
          init[idx] = {
            length_m: "",
            width_m: "",
            area_m2: "",
            sides: initialSides
          };
        }
      });
      setMeasurements(init);
      // Typed values are restored later, once the plans are known — see the reconciliation
      // effect. Restoring them here (blindly, keyed by room index) is what let one apartment's
      // measurements rehydrate into another apartment's rooms.
    } catch {
      router.replace("/upload");
    }
  }, [router]);

  function formatInput(val: string): string {
    if (!val) return "";
    return val.replace(/^0+(\d)/, "$1");
  }

  function updatePlanValue(roomIdx: number, itemId: string, value: string) {
    // allow a sum expression (digits, dot, plus) for measuring around a pillar
    const cleaned = value.replace(/,/g, ".").replace(/[^0-9.+]/g, "");
    setPlanValues((prev) => {
      const next = { ...prev, [roomIdx]: { ...(prev[roomIdx] || {}), [itemId]: cleaned } };
      persistDraft(next);
      return next;
    });
  }

  function planAreaFor(idx: number): number | null {
    const plan = plans[idx];
    if (!plan) return null;
    const a = computeArea(plan.recipe, evalVals(planValues[idx]));
    return a == null ? null : Math.round(a * 1000) / 1000;
  }

  // Restore typed values ONCE, after the plans are known. A room's values are restored only if
  // its plan signature is unchanged; if the polygon was edited in Review the plan describes
  // different walls, so the values are dropped and the room is flagged rather than silently
  // rebound. Scoped to the floor-plan image so another apartment's values can never rehydrate.
  useEffect(() => {
    if (!plansLoaded || restoredRef.current) return;
    restoredRef.current = true;
    let stored: DraftEnvelope | null = null;
    try { stored = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { stored = null; }
    if (!stored || stored.v !== DRAFT_VERSION || stored.scope !== (imageUrl || "")) return;
    const restored: Record<number, Record<string, string>> = {};
    const stale: number[] = [];
    Object.entries(stored.rooms || {}).forEach(([k, entry]) => {
      const idx = Number(k);
      const plan = plans[idx];
      if (!plan || !entry) return;
      if (entry.sig === planSignature(plan)) restored[idx] = entry.values || {};
      else if (Object.keys(entry.values || {}).length > 0) stale.push(idx);
    });
    if (Object.keys(restored).length) setPlanValues(restored);
    if (stale.length) setStaleRooms(stale);
  }, [plansLoaded, plans, imageUrl]);

  // Open the first room that still needs measuring, ONCE, after the plans arrive. Derived state
  // would slam a card shut the instant its last value is typed, so this is a one-shot init.
  useEffect(() => {
    if (!plansLoaded || didInitOpenRef.current || !rooms.length) return;
    didInitOpenRef.current = true;
    const first = rooms.findIndex((_r, i) => !isRoomMeasured(i));
    if (first >= 0) { setOpenRoom(first); setActiveRoom(first); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plansLoaded, rooms.length]);

  // Expanding a room makes it the active room, so the canvas shows exactly that room's
  // dimension lines. Collapsing clears it. Never auto-collapses on completion: the commonest
  // action right after entering the last wall is correcting an earlier one.
  function toggleRoom(idx: number) {
    setOpenRoom((cur) => {
      const next = cur === idx ? null : idx;
      setActiveRoom(next);
      setFocused(null);
      return next;
    });
  }

  // Persist typed values together with the signature of the plan they were measured against.
  function persistDraft(next: Record<number, Record<string, string>>) {
    const roomsOut: DraftEnvelope["rooms"] = {};
    Object.entries(next).forEach(([k, values]) => {
      const plan = plans[Number(k)];
      if (!plan) return;
      roomsOut[k] = { sig: planSignature(plan), values };
    });
    const env: DraftEnvelope = { v: DRAFT_VERSION, scope: imageUrl || "", rooms: roomsOut };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(env));
  }

  // Re-request the plan for ONE room, so a transient failure is recoverable without reloading
  // the page or losing any value already typed for the other rooms.
  async function retryRoomPlan(idx: number) {
    const room = rooms[idx];
    if (!room || retrying[idx]) return;
    setRetrying((p) => ({ ...p, [idx]: true }));
    try {
      const pts = getRoomPolygonPoints(room, imgAspectRatio);
      if (!pts || pts.length < 3) {
        setPlanIssues((p) => ({ ...p, [idx]: "no_geometry" }));
        return;
      }
      const plan = await getMeasurementPlan(pts, imgAspectRatio);
      if (plan && plan.supported) {
        setPlans((p) => ({ ...p, [idx]: plan }));
        setPlanIssues((p) => { const n = { ...p }; delete n[idx]; return n; });
      } else {
        setPlanIssues((p) => ({ ...p, [idx]: "unsupported" }));
      }
    } catch {
      setPlanIssues((p) => ({ ...p, [idx]: "error" }));
    } finally {
      setRetrying((p) => { const n = { ...p }; delete n[idx]; return n; });
    }
  }

  // A room counts as measured ONLY when it has a plan and every required value is entered.
  // A blocked room (no geometry / unsupported / plan request failed) can never pass, so
  // "Continue to review" stays disabled rather than letting an unmeasurable room through.
  function isRoomMeasured(idx: number): boolean {
    const plan = plans[idx];
    if (!plan) return false;
    return planComplete(plan, evalVals(planValues[idx]));
  }

  const measuredCount = rooms.reduce((n, _r, idx) => n + (isRoomMeasured(idx) ? 1 : 0), 0);
  const allFilled = rooms.length > 0 && measuredCount === rooms.length;

  const canvasRooms = rooms.map((r, idx) => {
    const m = measurements[idx];
    const rAny = r as unknown as Record<string, unknown>;
    return {
      room_name: r.room_name,
      is_balcony: r.is_balcony,
      bbox: r.bbox,
      confidence: r.confidence,
      source: r.source,
      shape: r.shape,
      polygon_points: r.polygon_points || (rAny.polygon_points as Array<{ x: number; y: number }> | undefined) || r.shape?.polygonPoints,
      shape_type: rAny.shape_type as string | undefined,
      length_m: m ? parseFloat(m.length_m) || 0 : 0,
      width_m: m ? parseFloat(m.width_m) || 0 : 0,
      sides: m ? m.sides || [] : [],
      plan: plans[idx] || undefined,
      planValues: plans[idx]
        ? Object.fromEntries(Object.entries(planValues[idx] || {}).map(
            ([k, v]) => [k, String(Math.round(evalSum(v) * 1000) / 1000)]))
        : undefined,
      measured: isRoomMeasured(idx),
    };
  });

  function handleContinue() {
    const measureData = rooms.map((r, idx) => {
      const rAny = r as unknown as Record<string, unknown>;
      const m = measurements[idx];
      const lm = parseFloat(m?.length_m || "0") || 0;
      const wm = parseFloat(m?.width_m || "0") || 0;
      const plan = plans[idx];
      const planArea = plan ? planAreaFor(idx) : null;
      const am = planArea ?? (parseFloat(m?.area_m2 || "0") || Math.round(lm * wm * 100) / 100);
      const sides = m?.sides || [];
      const updatedShape = r.shape || sides.length > 0 || plan
        ? {
            mode: r.shape?.mode || "polygon",
            polygon_points: r.shape?.polygonPoints || null,
            rotated_rect: r.shape?.rotatedRect || null,
            sides: sides.length > 0 ? sides.map(sideVal => parseFloat(sideVal) || 0) : undefined,
            // `labels` and `shape_class` are carried so Confirm (and the saved record) can show
            // WHICH measurement produced which number, instead of opaque ids. ShapeInput.measurement
            // is a free-form dict on the backend, so this is additive — no schema change.
            measurement: plan
              ? {
                  recipe: plan.recipe,
                  values: evalVals(planValues[idx]),
                  labels: Object.fromEntries(plan.items.map((it) => [it.id, it.label])),
                  shape_class: plan.shape_class,
                  area_m2: planArea,
                }
              : undefined,
          }
        : undefined;

      return {
        room_name: r.room_name,
        is_balcony: r.is_balcony,
        bbox: r.bbox,
        shape: updatedShape,
        polygon_points: (r.polygon_points || r.shape?.polygonPoints || (rAny.polygon_points as Array<{ x: number; y: number }> | undefined)) ?? null,
        shape_type: r.shape?.mode || (rAny.shape_type as string | undefined) || "rectangle",
        source: r.source || "ai",
        // Who positioned the room: "ai" | "user_marked" | "user_added". Stored in its own column
        // so it is queryable and so the saved-plan canvas can style user-placed rooms correctly.
        // REQUIRES backend/migrate_bbox_source.py to have run (widens varchar(10) -> varchar(20));
        // "user_marked" is 11 characters and overflows the original column.
        bbox_source: (r.source as string | undefined) || (rAny.bbox_source as string | undefined) || "ai",
        confidence: r.confidence,
        length_m: lm,
        width_m: wm,
        area_m2: am,
        sort_order: idx,
      };
    });
    sessionStorage.setItem("measure_result", JSON.stringify(measureData));
    sessionStorage.removeItem("measurements_draft");
    router.push("/confirm");
  }

  return (
    <>
    {imageUrl && (
      <FloorPlanViewer
        isOpen={viewerOpen}
        onClose={() => setViewerOpen(false)}
        imageUrl={imageUrl}
        rooms={canvasRooms}
        activeRoom={activeRoom}
        allMeasured={allFilled}
      />
    )}
    <div className="app-shell" style={{ height: "100dvh", maxHeight: "100dvh", overflow: "hidden" }}>
      <TopBar showBack onBack={() => { sessionStorage.setItem("came_from_measure", "true"); router.back(); }} />
      <ProgressBar currentStep={4} totalSteps={6} />

      {/* Floor plan canvas with live room overlays - Fixed at the top */}
      {imageUrl && (
        <div
          className="mx-4 mt-4 flex-shrink-0"
          ref={canvasWrapRef}
          style={{ background: "#fff", paddingBottom: 8 }}
        >
          <FloorPlanCanvas
            imageUrl={imageUrl}
            rooms={canvasRooms}
            focused={focused}
            activeRoom={activeRoom}
            allMeasured={allFilled}
            maxHeightPx={canvasMaxH}
          />
          <button
            onClick={() => setViewerOpen(true)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              width: "100%", marginTop: "8px", height: "36px",
              background: "rgba(74,74,74,0.08)", border: "1px solid rgba(74,74,74,0.15)",
              borderRadius: "8px", color: "#4A4A4A", fontSize: "13px",
              fontWeight: 500, cursor: "pointer",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
            View full screen
          </button>
        </div>
      )}

      {/* Scrollable measurements inputs */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[#4A4A4A] text-lg font-bold">Enter measurements</h2>
            <span className="text-xs text-gray-500 font-medium">
              {measuredCount}/{rooms.length} rooms measured
            </span>
          </div>

          {rooms.map((room, idx) => {
            const plan = plans[idx];
            const planArea = plan ? planAreaFor(idx) : null;
            const complete = isRoomMeasured(idx);
            const evalV = plan ? evalVals(planValues[idx]) : {};
            const closure = plan ? closureGap(plan.recipe, evalV) : null;
            const closePerim = Object.values(evalV).reduce((s, v) => s + v, 0);
            const closeWarn = closure !== null && closure > Math.max(0.05, 0.02 * closePerim);
            const hasInfeasible = plan ? plan.items.some((it) => it.feasible === false) : false;
            const isOpen = openRoom === idx;
            // "3/8 entered" on the collapsed header — a colour-only dot cannot distinguish
            // "untouched" from "seven of eight walls done".
            const requiredItems = plan ? plan.items.filter((it) => it.required) : [];
            const requiredCount = requiredItems.length;
            const filledCount = requiredItems.filter((it) => {
              const raw = (planValues[idx] || {})[it.id];
              return raw !== undefined && String(raw).trim() !== "";
            }).length;

            return (
              <div key={idx} className="bg-white border border-gray-100 rounded-xl p-4">
                {/* Collapsed header must be a COMPLETE status report — collapsing may shorten the
                    page but must never hide progress or a warning. */}
                <button
                  type="button"
                  onClick={() => toggleRoom(idx)}
                  aria-expanded={isOpen}
                  className={`w-full flex items-center justify-between gap-2 text-left ${isOpen ? "mb-3" : ""}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${complete ? "bg-green-500" : "bg-red-400"}`}
                      role="img"
                      aria-label={complete ? "measured" : "not measured"}
                    />
                    <span className="font-semibold text-[#4A4A4A] text-sm truncate">{room.room_name}</span>
                    {(closeWarn || hasInfeasible || planIssues[idx]) && (
                      <span className="text-[#B45309] text-xs flex-shrink-0" title="Needs attention" aria-label="needs attention">⚠</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {plan && requiredCount > 0 && (
                      <span className="text-[10px] text-gray-400 tabular-nums">{filledCount}/{requiredCount}</span>
                    )}
                    {planArea !== null && (
                      <span className="text-xs font-bold text-[#8B1A1A] tabular-nums">{planArea} m²</span>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${room.is_balcony ? "bg-orange-50 text-orange-600" : "bg-green-50 text-green-700"}`}>
                      {room.is_balcony ? "Exterior" : "Internal"}
                    </span>
                    <span className="text-gray-400 text-[10px] w-2">{isOpen ? "▾" : "▸"}</span>
                  </div>
                </button>

                {isOpen && (<>
                {!plansLoaded ? (
                  /* Plan still in flight. Render NO inputs at all — showing the legacy
                     Length x Width here would teach a measurement model we are removing, and
                     a transient backend error must never silently change the model. */
                  <div className="mt-1 animate-pulse" aria-busy="true">
                    <div className="h-3 w-40 bg-gray-100 rounded mb-3" />
                    <div className="h-10 bg-gray-50 border border-gray-100 rounded-xl mb-2" />
                    <div className="h-10 bg-gray-50 border border-gray-100 rounded-xl" />
                    <p className="text-[10px] text-gray-400 mt-2">Preparing measurements…</p>
                  </div>
                ) : plan ? (
                  <div className="mt-1">
                    {staleRooms.includes(idx) && (
                      <div className="mb-2 text-[11px] text-[#B45309] bg-orange-50 border border-orange-100 rounded-lg px-2.5 py-1.5">
                        You changed this room&rsquo;s shape in Review, so its previous measurements were cleared. Please measure it again.
                      </div>
                    )}
                    <h3 className="text-xs font-bold text-[#8B1A1A] mb-1 uppercase tracking-wide">
                      Measurements to take ({plan.shape_class})
                    </h3>
                    <p className="text-[10px] text-gray-400 mb-2">
                      Blocked by a pillar? Enter the parts with +, e.g. 2+0.1+1.9
                    </p>
                    <div className="flex flex-col gap-2">
                      {plan.items.map((it) => (
                        <div key={it.id} className="flex items-center gap-3 bg-gray-50 rounded-xl p-2.5 border border-gray-100">
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-semibold text-[#4A4A4A] block">{it.label}</span>
                            {it.kind === "diagonal" && (
                              <span className="text-[10px] text-orange-500 block">diagonal measurement</span>
                            )}
                          </div>
                          <div className="relative w-28 shrink-0">
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="0.000"
                              value={(planValues[idx] || {})[it.id] || ""}
                              onKeyDown={(e) => { if (e.key === ",") e.preventDefault(); }}
                              onFocus={() => { setFocused({ room: idx, item: it.id }); setActiveRoom(idx); }}
                              onBlur={() => setFocused(null)}
                              onChange={(e) => updatePlanValue(idx, it.id, e.target.value)}
                              className="w-full h-10 border border-gray-200 rounded-lg px-2 pr-6 text-base text-right font-semibold text-[#4A4A4A] focus:outline-none focus:border-[#8B1A1A] transition bg-white"
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-gray-400 font-semibold pointer-events-none">m</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {closeWarn && (
                      <div className="mt-2 text-[11px] text-[#B45309] bg-orange-50 border border-orange-100 rounded-lg px-2.5 py-1.5">
                        Walls don’t close (off by {closure!.toFixed(3)} m). Check for a mis-measured wall.
                      </div>
                    )}
                    {hasInfeasible && (
                      <div className="mt-2 text-[11px] text-[#B45309] bg-orange-50 border border-orange-100 rounded-lg px-2.5 py-1.5">
                        Some measurements cross the room (diagonal) and may be hard to take with a laser or tape. You can simplify the shape in Review.
                      </div>
                    )}
                  </div>
                ) : (
                  /* No plan for this room. This is NEVER a fallback to a different measurement
                     model — it is a blocked state with a stated reason and a way out. */
                  <div className="mt-1">
                    <div className="text-[11px] text-[#B45309] bg-orange-50 border border-orange-100 rounded-lg px-2.5 py-2">
                      {planIssues[idx] === "no_geometry"
                        ? `${room.room_name} isn't outlined on the plan yet, so its measurements can't be prepared.`
                        : planIssues[idx] === "unsupported"
                        ? "This room's outline is too complex to turn into measurements. Simplify or straighten it in Review."
                        : "Couldn't prepare the measurements for this room."}
                    </div>
                    <div className="flex gap-2 mt-2">
                      {planIssues[idx] === "error" && (
                        <button
                          onClick={() => retryRoomPlan(idx)}
                          disabled={!!retrying[idx]}
                          className="h-9 px-3 rounded-lg bg-[#8B1A1A] text-white text-xs font-semibold disabled:opacity-50"
                        >
                          {retrying[idx] ? "Retrying…" : "Retry"}
                        </button>
                      )}
                      <button
                        onClick={() => { sessionStorage.setItem("came_from_measure", "true"); router.push("/review"); }}
                        className="h-9 px-3 rounded-lg border border-gray-200 text-gray-600 text-xs font-medium"
                      >
                        Fix in Review
                      </button>
                    </div>
                  </div>
                )}

                {plan && planArea !== null && (
                  <div className="mt-3 pt-3 border-t border-dashed border-gray-100 flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-[#4A4A4A]">Total Area (m²)</span>
                      <span className="text-[10px] text-gray-400">Calculated from measurements</span>
                    </div>
                    <div className="relative w-36">
                      {/* Read-only: the area is derived from the measured values by the same
                          recipe the backend re-evaluates authoritatively on save. */}
                      <input
                        type="text"
                        readOnly
                        value={planArea.toString()}
                        className="w-full h-10 border border-gray-200 rounded-xl px-3 pr-8 text-base text-right font-bold text-[#8B1A1A] bg-[#F5E8E8] focus:outline-none"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#8B1A1A] font-bold pointer-events-none">m²</span>
                    </div>
                  </div>
                )}
                </>)}
              </div>
            );
          })}

          <button
            onClick={handleContinue}
            disabled={!allFilled}
            className="w-full h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-40 active:bg-[#6B1414] transition-colors mt-2"
          >
            Continue to review
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
