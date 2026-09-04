"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import ProgressBar from "@/components/ProgressBar";
import { saveFloorPlan, checkApartmentSimilarity, reassignFloorPlan } from "@/lib/api";
import { clearFlowSession } from "@/lib/flowKeys";

interface RoomData {
  room_name: string;
  is_balcony: boolean;
  length_m: number;
  width_m: number;
  area_m2?: number;
  sort_order: number;
}

// One room row on the summary. Replaces the old "{length_m} × {width_m} m" span, which read
// "0 × 0 m" for every guided-plan room because those rooms have no length/width by design.
//
// It deliberately does NOT synthesise a width × height pair: for an L-shape the implied
// rectangle contradicts the area beside it, and even an axis-aligned rectangle's two items are
// labelled "Wall 1 (right side)" / "Wall 2 (bottom)" — presenting those as length × width would
// state something false. Instead it names the method and, on tap, lists every measurement that
// produced the area, so the number can be audited against what was entered in Measure.
function RoomSummaryRow({ room, tone }: { room: RoomData; tone: "internal" | "exterior" }) {
  const [open, setOpen] = useState(false);
  const m = (room as unknown as { shape?: { measurement?: {
    values?: Record<string, number>; labels?: Record<string, string>; shape_class?: string;
  } } }).shape?.measurement;
  const values = m?.values || {};
  const labels = m?.labels || {};
  const ids = Object.keys(values);
  const area = room.area_m2 ?? 0;
  const ext = tone === "exterior";

  return (
    <div className={`rounded-xl border ${ext ? "bg-orange-50 border-orange-100" : "bg-white border-gray-100"}`}>
      <button
        type="button"
        onClick={() => ids.length > 0 && setOpen((o) => !o)}
        aria-expanded={ids.length > 0 ? open : undefined}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
      >
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ext ? "bg-orange-400" : "bg-green-500"}`} />
        <span className={`flex-1 text-sm font-medium ${ext ? "text-orange-800" : "text-gray-800"}`}>
          {room.room_name}
        </span>
        {ids.length > 0 && (
          <span className={`text-[11px] ${ext ? "text-orange-400" : "text-gray-400"}`}>
            {m?.shape_class ? `${m.shape_class} · ` : ""}{ids.length} measurement{ids.length === 1 ? "" : "s"}
            <span className="ml-1">{open ? "▾" : "▸"}</span>
          </span>
        )}
        <span className={`text-sm font-bold w-16 text-right ${ext ? "text-orange-700" : "text-[#4A4A4A]"}`}>
          {Math.round(area * 100) / 100} m²
        </span>
      </button>
      {open && ids.length > 0 && (
        <div className={`px-4 pb-2.5 pt-0 border-t ${ext ? "border-orange-100" : "border-gray-100"}`}>
          {ids.map((id) => (
            <div key={id} className="flex justify-between text-[11px] py-0.5">
              <span className={ext ? "text-orange-700" : "text-gray-500"}>{labels[id] || id}</span>
              <span className={`font-semibold ${ext ? "text-orange-800" : "text-gray-700"}`}>
                {values[id]} m
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConfirmPage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomData[]>([]);
  const [apartmentName, setApartmentName] = useState("");
  const [detectedName, setDetectedName] = useState(""); // AI-detected name, used for mismatch check
  const [address, setAddress] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [apartmentId, setApartmentId] = useState<string | undefined>(undefined);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [softFlags, setSoftFlags] = useState<Array<{ code: string; message: string }>>([]);
  const [similarityMatch, setSimilarityMatch] = useState<{
    apartment_id: string;
    apartment_name: string;
    similarity: number;
  } | null>(null);
  const [showSimilarityDialog, setShowSimilarityDialog] = useState(false);
  const isSaving = useRef(false);
  const [nameMismatch, setNameMismatch] = useState<{
    existing_name: string;
    detected_name: string;
    similarity: number;
  } | null>(null);
  const [showMismatchDialog, setShowMismatchDialog] = useState(false);
  const [savedFloorPlanId, setSavedFloorPlanId] = useState<string | null>(null);

  useEffect(() => {
    const measureRaw = sessionStorage.getItem("measure_result");
    const reviewRaw = sessionStorage.getItem("review_result");
    if (!measureRaw || !reviewRaw) { router.replace("/measure"); return; }
    try {
      const measure = JSON.parse(measureRaw);
      const review = JSON.parse(reviewRaw);
      setRooms(measure);
      setUploadId(review.upload_id || "");
      setImageUrl(review.image_url || null);
      setOriginalImageUrl(review.original_image_url || null);
      setThumbnailUrl(review.thumbnail_url || null);

      if (!review.image_url) {
        console.error("[Confirm] No image_url in review_result — redirecting to /upload");
        router.replace("/upload");
        return;
      }

      const uploadForApt = sessionStorage.getItem("upload_for_apartment");
      if (uploadForApt) {
        const { apartment_id, apartment_name } = JSON.parse(uploadForApt);
        setApartmentId(apartment_id);
        setApartmentName(apartment_name || ""); // existing name — displayed in header
        setDetectedName(review.apartment_name || ""); // AI-detected — sent for mismatch check
        console.log("[Confirm] upload-new-version flow");
        console.log("[Confirm] apartment_id from session:", apartment_id);
        console.log("[Confirm] existing apartment_name:", apartment_name);
        console.log("[Confirm] AI-detected apartment_name:", review.apartment_name);
      } else {
        setApartmentName(review.apartment_name || "");
        setDetectedName(review.apartment_name || "");
        console.log("[Confirm] new upload flow");
        console.log("[Confirm] apartment_id from session: (none)");
        console.log("[Confirm] apartment_name detected:", review.apartment_name);
      }
    } catch {
      router.replace("/upload");
    }
  }, [router]);

  const internal = rooms.filter((r) => !r.is_balcony);
  const exterior = rooms.filter((r) => r.is_balcony);
  // No length x width fallback: guided-plan rooms have length_m/width_m = 0 by design, so that
  // arm contributed a silent ZERO to the apartment total — a total short by one room with no
  // visible trace. area_m2 is always set by Measure for a room that reached this page.
  const totalInternal = Math.round(internal.reduce((s, r) => s + (r.area_m2 ?? 0), 0) * 100) / 100;
  const totalBalcony = Math.round(exterior.reduce((s, r) => s + (r.area_m2 ?? 0), 0) * 100) / 100;
  const totalM2 = Math.round((totalInternal + totalBalcony) * 100) / 100;

  function buildPayload(overrideApartmentId?: string) {
    // In upload-new-version flow, send the AI-detected name so the backend can
    // detect a mismatch. Fall back to apartmentName for new-upload flows.
    const nameForBackend = detectedName || apartmentName;
    return {
      upload_id: uploadId || undefined,
      apartment_id: overrideApartmentId || apartmentId || undefined,
      apartment_name: nameForBackend,
      address: address || undefined,
      image_url: imageUrl || undefined,
      original_image_url: originalImageUrl || undefined,
      thumbnail_url: thumbnailUrl || undefined,
      rooms: rooms.map((r) => {
        const rAny = r as unknown as Record<string, unknown>;
        return {
          ...r,
          shape_type: (rAny.shape_type as string) || "rectangle",
          bbox_source: (rAny.bbox_source as string) || "ai",
          room_name: (rAny.room_name as string) || "Unknown",
        };
      }),
      // True when the stager repositioned or added any room in Review, rather than accepting the
      // AI prediction as-is. Previously hardcoded false, so an edited plan was persisted claiming
      // it had never been touched.
      was_edited: rooms.some((r) => {
        const s = (r as unknown as Record<string, unknown>).source as string | undefined;
        return s === "user_marked" || s === "user_added";
      }),
      device_type: "mobile",
      confirmed_flags: softFlags.map((f) => f.code),
    };
  }

  async function doSave(overrideApartmentId?: string) {
    const payload = buildPayload(overrideApartmentId);
    const result = await saveFloorPlan(payload);

    // Check soft flags — pause and show warnings
    const soft = result.flags?.filter((f: { type: string }) => f.type === "soft") || [];
    if (soft.length > 0 && softFlags.length === 0) {
      setSoftFlags(soft);
      return;
    }

    // Check name mismatch — floor plan looks like a different apartment
    if (result.name_mismatch) {
      setNameMismatch(result.name_mismatch);
      setSavedFloorPlanId(result.floor_plan_id);
      setShowMismatchDialog(true);
      sessionStorage.setItem("save_result", JSON.stringify(result));
      return;
    }

    sessionStorage.setItem("save_result", JSON.stringify(result));
    clearFlowSession();
    router.push("/success");
  }

  async function handleSave() {
    if (isSaving.current) return;
    isSaving.current = true;
    setError("");
    setLoading(true);
    try {
      // Check similarity BEFORE saving — avoids double save
      if (apartmentName && apartmentName.trim().length >= 3 && !apartmentId) {
        const check = await checkApartmentSimilarity(apartmentName.trim());
        if (check.auto_match_apartment_id) {
          // High confidence auto-match — save directly under matched apartment
          await doSave(check.auto_match_apartment_id);
          return;
        }
        if (check.similarity_match) {
          // Medium confidence — show dialog, don't save yet
          setSimilarityMatch(check.similarity_match);
          setShowSimilarityDialog(true);
          return;
        }
      }
      await doSave();
    } catch (err: unknown) {
      console.error("[Confirm] Error:", err);
      let errMsg = "Failed to save floor plan";
      if (typeof err === "string") {
        errMsg = err;
      } else if (err instanceof Error) {
        errMsg = err.message.includes("flags")
          ? "Please review the warnings below and try again."
          : err.message;
      } else if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        errMsg = (e.message as string) || (e.detail as string) || (e.error as string) || JSON.stringify(err);
      }
      setError(errMsg);
    } finally {
      setLoading(false);
      isSaving.current = false;
    }
  }

  async function handleSimilarityConfirm(useSameApartment: boolean) {
    setShowSimilarityDialog(false);
    const matchedId = useSameApartment && similarityMatch ? similarityMatch.apartment_id : undefined;
    setSimilarityMatch(null);
    setLoading(true);
    isSaving.current = true;
    try {
      await doSave(matchedId);
    } catch (err: unknown) {
      console.error("[Confirm] Save error:", err);
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setLoading(false);
      isSaving.current = false;
    }
  }

  return (
    <div className="app-shell" style={{ position: "relative" }}>
      {/* Similarity match confirmation dialog */}
      {showSimilarityDialog && similarityMatch && (
        <div style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 1000, padding: "16px",
        }}>
          <div style={{
            background: "#fff", borderRadius: "16px", padding: "24px",
            width: "100%", maxWidth: "360px", boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 700, color: "#4A4A4A" }}>
              Similar apartment found
            </h3>
            <p style={{ fontSize: "13px", color: "#6B7280", margin: "0 0 12px" }}>
              We found an existing apartment that is {Math.round(similarityMatch.similarity * 100)}% similar:
            </p>
            <div style={{
              padding: "12px", background: "#F5E8E8", borderRadius: "10px",
              marginBottom: "12px", fontSize: "14px", fontWeight: 600, color: "#8B1A1A",
            }}>
              {similarityMatch.apartment_name}
            </div>
            <p style={{ fontSize: "13px", color: "#6B7280", margin: "0 0 20px" }}>
              Is this the same apartment, or a different one?
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <button
                onClick={() => handleSimilarityConfirm(true)}
                style={{
                  padding: "14px", background: "#8B1A1A", color: "#fff",
                  border: "none", borderRadius: "10px", fontSize: "14px",
                  fontWeight: 600, cursor: "pointer",
                }}
              >
                Same apartment — add as new version
              </button>
              <button
                onClick={() => handleSimilarityConfirm(false)}
                style={{
                  padding: "14px", background: "#fff", color: "#8B1A1A",
                  border: "1.5px solid #8B1A1A", borderRadius: "10px",
                  fontSize: "14px", fontWeight: 600, cursor: "pointer",
                }}
              >
                Different apartment — keep separate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Name mismatch dialog — uploaded floor plan looks like a different apartment */}
      {showMismatchDialog && nameMismatch && (
        <div style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 1000, padding: "16px",
        }}>
          <div style={{
            background: "#fff", borderRadius: "16px", padding: "24px",
            width: "100%", maxWidth: "380px", boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}>
            <div style={{ fontSize: "24px", textAlign: "center", marginBottom: "12px" }}>⚠️</div>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", fontWeight: 700, textAlign: "center", color: "#4A4A4A" }}>
              Different floor plan detected
            </h3>
            <p style={{ fontSize: "13px", color: "#6B7280", margin: "0 0 16px", textAlign: "center" }}>
              The uploaded floor plan appears to be different from the current apartment.
            </p>
            <div style={{
              background: "#F9FAFB", borderRadius: "8px", padding: "12px",
              marginBottom: "16px", fontSize: "13px",
            }}>
              <div style={{ marginBottom: "6px" }}>
                <span style={{ color: "#9CA3AF" }}>Current: </span>
                <strong style={{ color: "#4A4A4A" }}>{nameMismatch.existing_name}</strong>
              </div>
              <div>
                <span style={{ color: "#9CA3AF" }}>Detected: </span>
                <strong style={{ color: "#4A4A4A" }}>{nameMismatch.detected_name}</strong>
              </div>
              <div style={{ marginTop: "8px", fontSize: "11px", color: "#9CA3AF" }}>
                Match: {Math.round(nameMismatch.similarity * 100)}%
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <button
                onClick={() => {
                  setShowMismatchDialog(false);
                  setNameMismatch(null);
                  clearFlowSession();
                  router.push("/success");
                }}
                style={{
                  padding: "14px", background: "#8B1A1A", color: "#fff",
                  border: "none", borderRadius: "10px",
                  fontSize: "14px", fontWeight: 600, cursor: "pointer",
                }}
              >
                Keep as new version of current apartment
              </button>
              <button
                onClick={async () => {
                  setShowMismatchDialog(false);
                  if (savedFloorPlanId && nameMismatch) {
                    try {
                      await reassignFloorPlan(savedFloorPlanId, nameMismatch.detected_name);
                    } catch (e) {
                      console.error("[Confirm] Reassign failed:", e);
                    }
                  }
                  setNameMismatch(null);
                  clearFlowSession();
                  router.push("/success");
                }}
                style={{
                  padding: "14px", background: "#fff", color: "#8B1A1A",
                  border: "1.5px solid #8B1A1A", borderRadius: "10px",
                  fontSize: "14px", fontWeight: 600, cursor: "pointer",
                }}
              >
                Move to new apartment
              </button>
            </div>
          </div>
        </div>
      )}

      <TopBar showBack onBack={() => router.back()} />
      <ProgressBar currentStep={5} totalSteps={6} />

      <div className="flex-1 overflow-y-auto">
        {/* Summary header */}
        <div className="bg-[#4A4A4A] mx-4 mt-4 rounded-xl px-4 py-3">
          <p className="text-gray-300 text-xs mb-0.5">Apartment</p>
          <p className="text-white font-bold text-base leading-tight">{apartmentName}</p>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-[#8B1A1A]">{error}</div>
          )}

          {softFlags.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span className="text-sm font-semibold text-yellow-800">Warnings — review before saving</span>
              </div>
              {softFlags.map((f, i) => (
                <p key={i} className="text-xs text-yellow-700 ml-6">{f.message.split(": ").slice(1).join(": ")}</p>
              ))}
              <p className="text-xs text-yellow-600 mt-1 ml-6">Press &quot;Confirm &amp; save&quot; again to proceed anyway.</p>
            </div>
          )}

          {/* Internal rooms */}
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Internal Rooms</h3>
            <div className="flex flex-col gap-1.5">
              {internal.map((r, i) => (
                <RoomSummaryRow key={i} room={r} tone="internal" />
              ))}
            </div>
          </div>

          {/* Exterior */}
          {exterior.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Exterior</h3>
              <div className="flex flex-col gap-1.5">
                {exterior.map((r, i) => {
                  return (
                    <RoomSummaryRow key={i} room={r} tone="exterior" />
                  );
                })}
              </div>
            </div>
          )}

          {/* Totals */}
          <div className="bg-[#F5E8E8] rounded-xl px-4 py-4 flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-[#8B1A1A]">Total internal</span>
              <span className="text-xl font-black text-[#8B1A1A]">{totalInternal} m²</span>
            </div>
            {totalBalcony > 0 && (
              <div className="flex justify-between items-center border-t border-red-200 pt-2">
                <span className="text-sm text-orange-600">Balcony / exterior</span>
                <span className="text-base font-bold text-orange-600">{totalBalcony} m²</span>
              </div>
            )}
            <div className="flex justify-between items-center border-t border-red-200 pt-2">
              <span className="text-sm font-semibold text-[#4A4A4A]">Total</span>
              <span className="text-lg font-black text-[#4A4A4A]">{totalM2} m²</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-3 pb-4">
            <button
              onClick={handleSave}
              disabled={loading}
              className="w-full h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-60 flex items-center justify-center gap-2 active:bg-[#6B1414] transition-colors"
            >
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</> : "Confirm & save"}
            </button>
            <button
              onClick={() => router.back()}
              disabled={loading}
              className="w-full h-12 rounded-xl border-2 border-gray-200 text-gray-600 font-medium active:bg-gray-50 transition-colors"
            >
              Edit measurements
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
