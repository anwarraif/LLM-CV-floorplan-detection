"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import ProgressBar from "@/components/ProgressBar";
import RoomConfirmCanvas, { type RoomShape } from "@/components/RoomConfirmCanvas";
import { locateRooms as apiLocateRooms } from "@/lib/api";

const CONFIDENCE_THRESHOLD = 0.6;

type BBox = { x: number; y: number; w: number; h: number };

type RoomState = {
  room_name: string;
  is_balcony: boolean;
  confidence: number;
  bbox: BBox | null;
  aiBbox: BBox | null;
  source: "ai" | "user_marked" | "user_added";
  shape?: RoomShape;
  polygon_points?: Array<{ x: number; y: number }>;
};

type UploadRoom = {
  room_name: string;
  is_balcony: boolean;
  confidence: number;
  bbox: BBox | null;
  shape_type?: string;
  polygon_points?: Array<{ x: number; y: number }>;
};

// ── IoU utilities ──────────────────────────────────────────────────────────────
function calculateIoU(a: BBox, b: BBox): number {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function getManualConfidence(iou: number): number {
  if (iou >= 0.70) return 0.95;
  if (iou >= 0.50) return 0.80;
  if (iou >= 0.30) return 0.65;
  return 0.50;
}

function getBboxWarning(iou: number): string | null {
  if (iou >= 0.50) return null;
  if (iou >= 0.30) return "This looks quite different from what AI predicted. Make sure it covers the right room.";
  return "This is very different from AI prediction. Please double-check you have selected the correct room.";
}

// ── Confidence display helpers ─────────────────────────────────────────────────
function confBadgeStyle(conf: number, source: string) {
  if (source === "user_marked") {
    if (conf >= 0.70) return { bg: "#F0FAF4", border: "#BBF7D0", color: "#1A6B3C" };
    if (conf >= 0.50) return { bg: "#FFFBEB", border: "#FDE68A", color: "#B45309" };
    return { bg: "#FEF2F2", border: "#FECACA", color: "#B91C1C" };
  }
  if (conf >= 0.75) return { bg: "#F0FAF4", border: "#BBF7D0", color: "#1A6B3C" };
  return { bg: "#FFFBEB", border: "#FDE68A", color: "#B45309" };
}

function confBadgeLabel(conf: number, source: string): string {
  if (source === "user_marked") {
    if (conf >= 0.90) return "High confidence";
    if (conf >= 0.70) return "Good confidence";
    if (conf >= 0.50) return "Medium confidence";
    return "Low confidence — verify";
  }
  return `AI · ${Math.round(conf * 100)}%`;
}

const VARIANT_STYLES = {
  green: { border: "3px solid #1A6B3C", background: "#F0FAF4", iconColor: "#1A6B3C", subColor: "#6B7280" },
  amber: { border: "1.5px dashed #B45309", background: "#FFFBEB", iconColor: "#B45309", subColor: "#B45309" },
  blue:  { border: "3px solid #1D4ED8",  background: "#EFF6FF", iconColor: "#1D4ED8", subColor: "#3B82F6" },
} as const;

function getSummaryVariant(room: RoomState): keyof typeof VARIANT_STYLES {
  if (room.source === "user_added" && !room.bbox) return "blue";
  if (room.bbox && (room.confidence >= CONFIDENCE_THRESHOLD || room.source === "user_marked")) return "green";
  return "amber";
}

export default function ReviewPage() {
  const router = useRouter();

  // ── Data ──────────────────────────────────────────────────────────────────
  const [apartmentName, setApartmentName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [orientation, setOrientation] = useState("axis-aligned");
  const [rooms, setRooms] = useState<RoomState[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ── Phase 1: room-by-room confirmation ────────────────────────────────────
  const [confirmStep, setConfirmStep] = useState<"confirming" | "summary">("confirming");
  const [currentRoomIndex, setCurrentRoomIndex] = useState(0);
  const [adjustMode, setAdjustMode] = useState(false);

  // ── IoU warning modal ─────────────────────────────────────────────────────
  const [iouWarning, setIouWarning] = useState<{
    bbox: BBox; shape?: RoomShape; iou: number; message: string;
  } | null>(null);

  const [returnToSummary, setReturnToSummary] = useState(false);

  // ── Phase 2: summary ──────────────────────────────────────────────────────
  const [newRoomName, setNewRoomName] = useState("");
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [markingRoomIndex, setMarkingRoomIndex] = useState<number | null>(null);

  // ── Load rooms ────────────────────────────────────────────────────────────
  useEffect(() => {
    const uploadResultRaw = sessionStorage.getItem("upload_result");
    if (!uploadResultRaw) { router.replace("/upload"); return; }

    const cameFromMeasure = sessionStorage.getItem("came_from_measure") === "true";
    const reviewCompleted = sessionStorage.getItem("review_completed") === "true";
    const reviewResultRaw = sessionStorage.getItem("review_result");

    // ONLY valid skip: user pressed Back from measure with a completed review
    if (cameFromMeasure && reviewCompleted && reviewResultRaw) {
      sessionStorage.removeItem("came_from_measure");
      try {
        const data = JSON.parse(reviewResultRaw);
        setApartmentName(data.apartment_name || "");
        setUploadId(data.upload_id || "");
        setImageUrl(data.image_url || "");
        setRooms((data.rooms || []).map((r: RoomState) => ({ ...r, aiBbox: r.bbox })));
        setConfirmStep("summary");
        setLoading(false);
        return;
      } catch { /* fall through to fresh start */ }
    }

    // ALL other cases: clear stale keys, start fresh from Room 1
    sessionStorage.removeItem("review_completed");
    sessionStorage.removeItem("review_result");
    sessionStorage.removeItem("came_from_measure");

    async function init() {
      const specRaw = sessionStorage.getItem("specified_rooms");
      try {
        const uploadData = JSON.parse(uploadResultRaw!);
        setApartmentName(uploadData.apartment_name || "");
        setUploadId(uploadData.upload_id || "");
        setImageUrl(uploadData.image_url || "");
        setOrientation(uploadData.floor_plan_orientation || "axis-aligned");

        const aiRooms: UploadRoom[] = uploadData.rooms || [];
        const specRooms: Array<{ room_name: string; is_balcony: boolean }> | null = specRaw
          ? JSON.parse(specRaw)
          : null;

        if (!specRooms || specRooms.length === 0) {
          setRooms(aiRooms.map((r) => ({
            room_name: r.room_name,
            is_balcony: r.is_balcony,
            confidence: r.confidence ?? 0.0,
            bbox: r.bbox || null,
            aiBbox: r.bbox || null,
            source: "ai" as const,
            polygon_points: r.polygon_points || undefined,
            shape: r.polygon_points && r.polygon_points.length >= 3
              ? { mode: "polygon" as const, polygonPoints: r.polygon_points }
              : undefined,
          })));
          setLoading(false);
          return;
        }

        const knownRooms = aiRooms
          .filter((r) => r.confidence >= CONFIDENCE_THRESHOLD && r.bbox)
          .map((r) => ({
            room_name: r.room_name,
            is_balcony: r.is_balcony,
            bbox: r.bbox,
            confidence: r.confidence,
            shape_type: r.shape_type,
            polygon_points: r.polygon_points,
          }));

        const result = await apiLocateRooms(uploadData.image_url, specRooms, knownRooms, uploadData.floor_plan_orientation || "axis-aligned");
        const locatedMap = new Map((result.rooms || []).map((r) => [r.room_name.toLowerCase().trim(), r]));

        setRooms(specRooms.map((sr) => {
          const located = locatedMap.get(sr.room_name.toLowerCase().trim());
          const hasBbox = !!(located?.bbox && (located.confidence ?? 0) >= CONFIDENCE_THRESHOLD);
          const bbox = hasBbox ? located!.bbox! : null;
          const pts = (located as Record<string, unknown>)?.polygon_points as Array<{ x: number; y: number }> | undefined;
          return {
            room_name: sr.room_name,
            is_balcony: sr.is_balcony,
            confidence: located?.confidence ?? 0.0,
            bbox,
            aiBbox: bbox,
            source: "ai" as const,
            polygon_points: pts || undefined,
            shape: pts && pts.length >= 3
              ? { mode: "polygon" as const, polygonPoints: pts }
              : undefined,
          };
        }));
      } catch {
        setLoadError("Failed to locate rooms. Please check your connection and try again.");
      } finally {
        setLoading(false);
      }
    }

    init();
  }, [router]);

  // Skip confirming phase if no rooms
  useEffect(() => {
    if (!loading && rooms.length === 0) setConfirmStep("summary");
  }, [loading, rooms.length]);

  // ── Phase 1 helpers ───────────────────────────────────────────────────────
  function goToRoom(idx: number) {
    setCurrentRoomIndex(idx);
    setConfirmStep("confirming");
    setAdjustMode(false);
    setReturnToSummary(true);
  }

  function advanceRoom() {
    setAdjustMode(false);
    if (returnToSummary) {
      setReturnToSummary(false);
      setConfirmStep("summary");
      return;
    }
    if (currentRoomIndex < rooms.length - 1) {
      setCurrentRoomIndex((i) => i + 1);
    } else {
      setConfirmStep("summary");
    }
  }

  function handleLooksRight() {
    advanceRoom();
  }

  // FIX 2B: IoU-based confidence for manually drawn bbox
  function handleShapeDrawn(bbox: BBox, shape?: RoomShape) {
    const room = rooms[currentRoomIndex];
    const aiBbox = room.aiBbox;

    let confidence: number;
    if (aiBbox) {
      const iou = calculateIoU(bbox, aiBbox);
      confidence = getManualConfidence(iou);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[BBox] ${room.room_name}: IoU=${iou.toFixed(2)} confidence=${confidence}`);
      }
      const warning = getBboxWarning(iou);
      if (warning) {
        setIouWarning({ bbox, shape, iou, message: warning });
        return; // pause — show warning modal
      }
    } else {
      confidence = 0.75; // no AI prediction to compare against
    }

    setRooms((prev) => {
      const next = [...prev];
      next[currentRoomIndex] = {
        ...next[currentRoomIndex],
        bbox,
        shape,
        source: "user_marked",
        confidence,
        polygon_points: shape?.polygonPoints || undefined
      };
      return next;
    });
    advanceRoom();
  }

  function confirmIouWarning() {
    if (!iouWarning) return;
    const { bbox, shape, iou } = iouWarning;
    const confidence = getManualConfidence(iou);
    setRooms((prev) => {
      const next = [...prev];
      next[currentRoomIndex] = {
        ...next[currentRoomIndex],
        bbox,
        shape,
        source: "user_marked",
        confidence,
        polygon_points: shape?.polygonPoints || undefined
      };
      return next;
    });
    setIouWarning(null);
    advanceRoom();
  }

  function dismissIouWarning() {
    setIouWarning(null);
    // Return to draw mode so user can try again
  }

  // ── Phase 2 helpers ───────────────────────────────────────────────────────
  function removeRoom(index: number) {
    setRooms((prev) => prev.filter((_, i) => i !== index));
  }

  function addRoom() {
    const name = newRoomName.trim();
    if (!name) return;
    const isBalcony = /balcony|deck|terrace|porch/i.test(name);
    setRooms((prev) => [...prev, { room_name: name, is_balcony: isBalcony, confidence: 0.0, bbox: null, aiBbox: null, source: "user_added" }]);
    setNewRoomName("");
    setShowAddRoom(false);
    if (imageUrl) {
      (async () => {
        try {
          const result = await apiLocateRooms(imageUrl, [{ room_name: name, is_balcony: isBalcony }], [], orientation);
          const located = result.rooms?.[0];
          if (located?.bbox && located.confidence >= CONFIDENCE_THRESHOLD) {
            setRooms((prev) => {
              const next = [...prev];
              const idx = next.findIndex((r) => r.room_name.toLowerCase().trim() === name.toLowerCase().trim() && r.source === "user_added");
              if (idx >= 0) next[idx] = { ...next[idx], bbox: located.bbox!, aiBbox: located.bbox!, confidence: located.confidence, source: "user_marked" };
              return next;
            });
          }
        } catch { /* stays blue */ }
      })();
    }
  }

  function handleMarkShapeDrawn(bbox: BBox, shape?: RoomShape) {
    if (markingRoomIndex === null) return;
    const room = rooms[markingRoomIndex];
    const aiBbox = room.aiBbox;
    const confidence = aiBbox ? getManualConfidence(calculateIoU(bbox, aiBbox)) : 0.75;
    setRooms((prev) => {
      const next = [...prev];
      next[markingRoomIndex] = {
        ...next[markingRoomIndex],
        bbox,
        shape,
        source: "user_marked",
        confidence,
        polygon_points: shape?.polygonPoints || undefined
      };
      return next;
    });
    setMarkingRoomIndex(null);
  }

  function handleContinue() {
    const uploadRaw = sessionStorage.getItem("upload_result");
    const uploadData = uploadRaw ? JSON.parse(uploadRaw) : null;
    const reviewData = {
      upload_id: uploadId,
      apartment_name: apartmentName,
      image_url: imageUrl,
      original_image_url: uploadData?.original_image_url || null,
      thumbnail_url: uploadData?.thumbnail_url || null,
      rooms: rooms.map((r, i) => ({
        room_name: r.room_name,
        is_balcony: r.is_balcony,
        confidence: r.confidence,
        bbox: r.bbox,
        shape: r.shape,
        source: r.source,
        sort_order: i,
        polygon_points: r.shape?.polygonPoints || r.polygon_points || null,
      })),
    };
    sessionStorage.setItem("review_result", JSON.stringify(reviewData));
    sessionStorage.setItem("review_completed", "true"); // FIX 3C: skip AI on back nav
    router.push("/measure");
  }

  const aiConfirmedCount  = rooms.filter((r) => r.source === "ai" && r.bbox).length;
  const manualAdjustedCount = rooms.filter((r) => r.source === "user_marked").length;
  const greenCount = rooms.filter((r) => getSummaryVariant(r) === "green").length;
  const amberCount = rooms.filter((r) => getSummaryVariant(r) === "amber").length;
  const currentRoom = rooms[currentRoomIndex];

  // ── Loading / error ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="app-shell">
        <TopBar showBack onBack={() => router.back()} />
        <ProgressBar currentStep={3} totalSteps={6} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "48px 0" }}>
          <div className="w-10 h-10 border-2 border-[#8B1A1A] border-t-transparent rounded-full animate-spin" />
          <p style={{ color: "#6B7280", fontSize: "14px", textAlign: "center" }}>
            AI is locating rooms on the floor plan…
          </p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="app-shell">
        <TopBar showBack onBack={() => router.back()} />
        <ProgressBar currentStep={3} totalSteps={6} />
        <div className="px-4 py-6">
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-[#8B1A1A]">{loadError}</div>
        </div>
      </div>
    );
  }

  // ── PHASE 1: Room-by-room confirmation ────────────────────────────────────
  if (confirmStep === "confirming" && currentRoom) {
    const hasBbox = !!currentRoom.bbox;
    const conf = currentRoom.confidence ?? 0;
    const cs = confBadgeStyle(conf, currentRoom.source);

    return (
      <div className="app-shell">
        <TopBar showBack onBack={() => router.back()} />
        <ProgressBar currentStep={3} totalSteps={6} />

        <div className="flex-1 overflow-y-auto">
          {/* Header */}
          <div style={{ padding: "14px 16px 0" }}>
            {/* FIX 3D: Back button + room counter */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
              <button
                onClick={() => { if (currentRoomIndex > 0) { setCurrentRoomIndex((i) => i - 1); setAdjustMode(false); } }}
                disabled={currentRoomIndex === 0}
                style={{
                  background: "none", border: "none",
                  cursor: currentRoomIndex === 0 ? "default" : "pointer",
                  color: currentRoomIndex === 0 ? "#E5E7EB" : "#6B7280",
                  fontSize: "13px", fontWeight: 500, padding: "4px 0",
                  display: "flex", alignItems: "center", gap: "2px",
                }}
              >
                ← Back
              </button>
              <span style={{ fontSize: "12px", color: "#9CA3AF", fontWeight: 500 }}>
                Room {currentRoomIndex + 1} of {rooms.length}
              </span>
            </div>

            <h2 style={{ fontSize: "18px", fontWeight: 700, color: "#1A1A1A", margin: "0 0 6px" }}>
              {adjustMode
                ? `Draw box: "${currentRoom.room_name}"`
                : `Where is "${currentRoom.room_name}"?`}
            </h2>

            {!adjustMode && (
              <span style={{
                display: "inline-block", fontSize: "12px", fontWeight: 500,
                borderRadius: "999px", padding: "2px 10px",
                color: hasBbox ? cs.color : "#6B7280",
                background: hasBbox ? cs.bg : "#F3F4F6",
                border: hasBbox ? `1px solid ${cs.border}` : "1px solid #E5E7EB",
              }}>
                {hasBbox
                  ? `AI placed this here · ${Math.round(conf * 100)}% confidence`
                  : "AI couldn't locate this room"}
              </span>
            )}

            {adjustMode && (
              <p style={{ fontSize: "13px", color: "#6B7280", margin: "4px 0 0" }}>
                Drag on the image to draw a box around the room
              </p>
            )}
          </div>

          {/* Canvas */}
          {imageUrl && (
            <div style={{ padding: "12px 16px 0" }}>
              <RoomConfirmCanvas
                imageUrl={imageUrl}
                allRooms={rooms}
                currentRoomIndex={currentRoomIndex}
                adjustMode={adjustMode}
                onShapeDrawn={handleShapeDrawn}
              />
            </div>
          )}

          {/* Action buttons — FIX 3A: no "Skip all", FIX 3B: no "Can't see it" */}
          <div style={{ padding: "12px 16px 28px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {!adjustMode && (
              <>
                {hasBbox && (
                  <button
                    onClick={handleLooksRight}
                    style={{
                      width: "100%", height: "48px", borderRadius: "12px",
                      background: "#1A6B3C", color: "#fff",
                      fontWeight: 600, fontSize: "15px", border: "none", cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Looks right
                  </button>
                )}

                <button
                  onClick={() => setAdjustMode(true)}
                  style={{
                    width: "100%", height: "48px", borderRadius: "12px",
                    background: "#FFFBEB", color: "#B45309",
                    fontWeight: 600, fontSize: "14px",
                    border: "1.5px solid #FDE68A", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  {hasBbox ? "Adjust" : "Draw box"}
                </button>
              </>
            )}

          </div>
        </div>

        {/* FIX 2B: IoU warning modal */}
        {iouWarning && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 60,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "flex-end",
          }}>
            <div style={{
              width: "100%", background: "#fff",
              borderRadius: "20px 20px 0 0",
              padding: "24px 20px 32px",
            }}>
              <div style={{ fontSize: "18px", fontWeight: 700, color: "#1A1A1A", marginBottom: "8px" }}>
                Check your selection
              </div>
              <p style={{ fontSize: "14px", color: "#4B5563", lineHeight: "1.5", marginBottom: "20px" }}>
                {iouWarning.message}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <button
                  onClick={confirmIouWarning}
                  style={{
                    width: "100%", height: "48px", borderRadius: "12px",
                    background: "#8B1A1A", color: "#fff",
                    fontWeight: 600, fontSize: "15px", border: "none", cursor: "pointer",
                  }}
                >
                  Keep my selection
                </button>
                <button
                  onClick={dismissIouWarning}
                  style={{
                    width: "100%", height: "44px", borderRadius: "12px",
                    background: "#F3F4F6", color: "#374151",
                    fontWeight: 500, fontSize: "14px", border: "none", cursor: "pointer",
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── PHASE 2: Summary ──────────────────────────────────────────────────────
  return (
    <div style={{ position: "relative" }}>
      <div className="app-shell">
        <TopBar
          showBack
          onBack={() => {
            if (rooms.length > 0) { setCurrentRoomIndex(rooms.length - 1); setConfirmStep("confirming"); }
            else router.back();
          }}
        />
        <ProgressBar currentStep={3} totalSteps={6} />

        <div className="flex-1 px-4 py-6 flex flex-col gap-5 overflow-y-auto">

          {/* FIX 3E: Updated summary header */}
          <div>
            <h2 style={{ fontSize: "20px", fontWeight: 700, color: "#1A1A1A", marginBottom: "6px" }}>
              All rooms confirmed!
            </h2>
            <p style={{ fontSize: "13px", color: "#6B7280" }}>
              {aiConfirmedCount > 0 && `${aiConfirmedCount} confirmed automatically`}
              {aiConfirmedCount > 0 && manualAdjustedCount > 0 && " · "}
              {manualAdjustedCount > 0 && `${manualAdjustedCount} adjusted manually`}
            </p>
          </div>

          {/* Status pills */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{
              display: "inline-flex", alignItems: "center", gap: "6px",
              background: "#F0FAF4", border: "1px solid #BBF7D0",
              borderRadius: "999px", padding: "4px 12px",
              fontSize: "12px", fontWeight: 600, color: "#1A6B3C",
            }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#1A6B3C", display: "inline-block" }} />
              {greenCount} confirmed
            </span>
            {amberCount > 0 && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                background: "#FFFBEB", border: "1px solid #FDE68A",
                borderRadius: "999px", padding: "4px 12px",
                fontSize: "12px", fontWeight: 600, color: "#B45309",
              }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#B45309", display: "inline-block" }} />
                {amberCount} need a box
              </span>
            )}
          </div>

          {/* Apartment name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#4A4A4A]">Apartment name</label>
            <input
              type="text"
              value={apartmentName}
              onChange={(e) => setApartmentName(e.target.value)}
              placeholder="e.g. 4A/132 Vincent Street, Auckland"
              className="h-12 border border-gray-200 rounded-xl px-4 text-base text-gray-800 focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
            />
          </div>

          {/* FIX 3E: Room list with confidence badge + source badge */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[#4A4A4A]">Rooms</h3>

            {rooms.map((room, i) => {
              const variant = getSummaryVariant(room);
              const s = VARIANT_STYLES[variant];
              const cs = confBadgeStyle(room.confidence, room.source);
              const isUserMarked = room.source === "user_marked";
              const isLowConf = isUserMarked && room.confidence < 0.50;

              return (
                <div
                  key={`${room.room_name}-${i}`}
                  onClick={() => goToRoom(i)}
                  style={{
                    display: "flex", alignItems: "center", gap: "12px",
                    background: isLowConf ? "#FEF2F2" : s.background,
                    border: isLowConf ? "1.5px solid #FECACA" : s.border,
                    borderRadius: "12px", padding: "10px 12px", minHeight: "56px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ flexShrink: 0, color: isLowConf ? "#B91C1C" : s.iconColor, width: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {variant === "green" && !isLowConf && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                    )}
                    {(variant === "amber" || isLowConf) && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    )}
                    {variant === "blue" && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
                      </svg>
                    )}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "14px", color: "#1A1A1A" }}>{room.room_name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "3px", flexWrap: "wrap" }}>
                      {room.bbox && (
                        <span style={{
                          fontSize: "11px", fontWeight: 500, borderRadius: "999px", padding: "1px 7px",
                          color: cs.color, background: cs.bg, border: `1px solid ${cs.border}`,
                        }}>
                          {confBadgeLabel(room.confidence, room.source)}
                        </span>
                      )}
                      {room.bbox && (
                        <span style={{
                          fontSize: "11px", fontWeight: 600, borderRadius: "999px", padding: "1px 7px",
                          color: isUserMarked ? "#1D4ED8" : "#1A6B3C",
                          background: isUserMarked ? "#EFF6FF" : "#F0FAF4",
                          border: `1px solid ${isUserMarked ? "#BFDBFE" : "#BBF7D0"}`,
                        }}>
                          {isUserMarked ? "You" : "AI"}
                        </span>
                      )}
                      {!room.bbox && (
                        <span style={{ fontSize: "12px", color: s.subColor }}>
                          {variant === "amber" ? "No box drawn — tap Mark to locate" : "Added by you — tap Mark to locate"}
                        </span>
                      )}
                      {isLowConf && (
                        <span style={{ fontSize: "11px", color: "#B91C1C" }}>
                          Please re-check this room
                        </span>
                      )}
                    </div>
                  </div>

                  {(variant === "amber" || variant === "blue") ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); setMarkingRoomIndex(i); }}
                      style={{
                        display: "flex", alignItems: "center", gap: "4px",
                        minHeight: "44px", padding: "0 12px",
                        background: s.iconColor, color: "#fff",
                        border: "none", borderRadius: "8px",
                        fontSize: "13px", fontWeight: 600, cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      Mark
                    </button>
                  ) : variant === "green" ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); goToRoom(i); }}
                      style={{
                        display: "flex", alignItems: "center", gap: "4px",
                        minHeight: "44px", padding: "0 12px",
                        background: "transparent", color: "#1A6B3C",
                        border: "1.5px solid #BBF7D0", borderRadius: "8px",
                        fontSize: "13px", fontWeight: 600, cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      ✎ Edit
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeRoom(i); }}
                      style={{
                        minHeight: "44px", minWidth: "44px", padding: "0 8px",
                        background: "transparent", border: "none", color: "#9CA3AF",
                        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}

            {/* Add room */}
            {showAddRoom ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addRoom()}
                  placeholder="Room name, e.g. Study"
                  autoFocus
                  className="flex-1 h-11 border border-gray-200 rounded-xl px-4 text-sm focus:outline-none focus:border-[#8B1A1A] transition"
                />
                <button onClick={addRoom} className="h-11 px-4 rounded-xl bg-[#8B1A1A] text-white text-sm font-medium">Add</button>
                <button onClick={() => setShowAddRoom(false)} className="h-11 px-3 rounded-xl border border-gray-200 text-gray-500 text-sm">Cancel</button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddRoom(true)}
                className="flex items-center gap-2 h-11 border-2 border-dashed border-gray-200 rounded-xl px-4 text-sm text-gray-500 active:bg-gray-50 transition-colors"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Add room
              </button>
            )}
          </div>

          <div className="mt-auto pt-4">
            <button
              onClick={handleContinue}
              disabled={rooms.length === 0 || !apartmentName.trim()}
              className="w-full h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-60 active:bg-[#6B1414] transition-colors"
            >
              Continue to measure
            </button>
          </div>
        </div>
      </div>

      {/* Mark modal */}
      {markingRoomIndex !== null && imageUrl && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 50,
          background: "rgba(0,0,0,0.96)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            padding: "14px 16px 8px",
            display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
          }}>
            <div>
              <div style={{ color: "#fff", fontSize: "16px", fontWeight: 600 }}>
                Mark &ldquo;{rooms[markingRoomIndex]?.room_name}&rdquo;
              </div>
              <div style={{ color: "rgba(255,255,255,0.5)", fontSize: "13px", marginTop: "2px" }}>
                Drag to draw a box around this room
              </div>
            </div>
            <button
              onClick={() => setMarkingRoomIndex(null)}
              style={{
                minHeight: "44px", minWidth: "44px",
                background: "rgba(255,255,255,0.1)", border: "none",
                borderRadius: "8px", color: "#fff", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: "0 12px 12px" }}>
            <RoomConfirmCanvas
              imageUrl={imageUrl}
              allRooms={rooms}
              currentRoomIndex={markingRoomIndex}
              adjustMode={true}
              onShapeDrawn={handleMarkShapeDrawn}
            />
          </div>
        </div>
      )}
    </div>
  );
}
