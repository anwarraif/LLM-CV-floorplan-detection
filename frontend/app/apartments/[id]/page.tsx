"use client";

import React, { useState, useEffect, useRef, use } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import FloorPlanCanvas from "@/components/FloorPlanCanvas";
import { getApartmentVersions, getApartmentVersion, type VersionListItem, type FloorPlanDetail, type RoomDetail } from "@/lib/api";
import type { RoomShape } from "@/components/RoomConfirmCanvas";
import { clearFlowSession } from "@/lib/flowKeys";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

function buildImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = API_URL.replace(/\/$/, "");
  const path = url.startsWith("/") ? url : "/" + url;
  return base + path;
}

type BBox = { x: number; y: number; w: number; h: number };

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function avgConfidence(rooms: RoomDetail[]): number | null {
  const cs = rooms.map((r) => r.bbox).filter(Boolean).length;
  if (cs === 0) return null;
  // approximate — AI confidence is stored per room in DB but not in RoomDetail yet
  return null;
}

export default function ApartmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [versions, setVersions] = useState<VersionListItem[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FloorPlanDetail | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [apartmentName, setApartmentName] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [expandedRoomIds, setExpandedRoomIds] = useState<string[]>([]);
  const toggleRoomExpanded = (roomId: string) => {
    setExpandedRoomIds((prev) =>
      prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId]
    );
  };
  const touchRef = useRef({ startY: 0, startX: 0 });

  useEffect(() => {
    if (window.innerWidth >= 768) {
      setVersionsOpen(true);
      return;
    }
    // Poll every 150ms — catches scroll regardless of which element scrolls
    let lastScrollY = 0;
    const checkScroll = () => {
      let maxScroll = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      document.querySelectorAll<HTMLElement>('*').forEach(el => {
        if (el.scrollTop > 0) maxScroll = Math.max(maxScroll, el.scrollTop);
      });
      if (Math.abs(maxScroll - lastScrollY) > 10) {
        lastScrollY = maxScroll;
        setVersionsOpen(false);
      }
    };
    const interval = setInterval(checkScroll, 150);
    return () => clearInterval(interval);
  }, []);

  const onPageTouchStart = (e: React.TouchEvent) => {
    touchRef.current.startY = e.touches[0].clientY;
  };

  const onPageTouchMove = (e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return;
    const dy = Math.abs(e.touches[0].clientY - touchRef.current.startY);
    if (dy > 10) setVersionsOpen(false);
  };

  const handleVersionSelect = (versionId: string) => {
    setSelectedVersionId(versionId);
    setShowOriginal(false);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setVersionsOpen(false);
    }
  };

  useEffect(() => {
    getApartmentVersions(id)
      .then((data) => {
        setVersions(data);
        if (data.length > 0) {
          setSelectedVersionId(data[0].floor_plan_id);
          setShowOriginal(false);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!selectedVersionId) return;
    setDetailLoading(true);
    getApartmentVersion(id, selectedVersionId)
      .then((d) => {
        setDetail(d);
        setApartmentName(d.apartment_name);
        setAddress(d.address ?? null);
      })
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [id, selectedVersionId]);

  // Canvas rooms
  const canvasRooms = (detail?.rooms ?? []).map((r) => ({
    room_name: r.room_name,
    is_balcony: r.is_balcony,
    bbox: r.bbox as BBox | null,
    confidence: 1,
    source: (r.source ?? "ai") as "ai" | "user_marked" | "user_added",
    shape: r.shape as RoomShape | undefined,
    length_m: r.length_m,
    width_m: r.width_m,
    sides: (r.shape as { sides?: Array<number | string> } | null)?.sides || [],
  }));

  const internal = (detail?.rooms ?? []).filter((r) => !r.is_balcony);
  const exterior = (detail?.rooms ?? []).filter((r) => r.is_balcony);

  // FIX 4: fall back to any version that has an image when the selected one doesn't
  const canvasImageUrl = detail?.image_url || versions.find((v) => v.image_url)?.image_url || null;


  if (loading) {
    return (
      <AppShell>
        <div style={{ textAlign: "center", paddingTop: 80, color: "#aaa" }}>Loading…</div>
      </AppShell>
    );
  }

  const selectedVersion = versions.find((v) => v.floor_plan_id === selectedVersionId);

  return (
    <div
      onTouchStart={onPageTouchStart}
      onTouchMove={onPageTouchMove}
    >
    <AppShell>
      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid #eee", padding: "20px 28px" }}>
        <button
          onClick={() => router.push("/apartments")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#8B1A1A",
            fontWeight: 600,
            fontSize: 13,
            padding: 0,
            marginBottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          ← Apartments
        </button>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#4A4A4A", margin: "0 0 2px" }}>
              {apartmentName || "Apartment"}
            </h1>
            {address && <p style={{ color: "#888", fontSize: 13, margin: 0 }}>{address}</p>}
          </div>
          <button
            onClick={() => {
              ["review_completed", "review_result", "measurements_draft", "came_from_measure", "specified_rooms", "upload_result", "confirm_data"].forEach(
                (key) => sessionStorage.removeItem(key)
              );
              sessionStorage.setItem("upload_for_apartment", JSON.stringify({ apartment_id: id, apartment_name: apartmentName }));
              router.push("/upload");
            }}
            style={{
              background: "#8B1A1A",
              color: "white",
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Upload new version
          </button>
        </div>
      </div>

      <div className="apt-detail-layout">
        {/* Versions panel */}
        <div className="apt-detail-versions">
          {/* Header with toggle */}
          <button
            onClick={() => setVersionsOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              width: "100%", padding: "0 8px 8px", minHeight: 44,
              background: "none", border: "none", cursor: "pointer",
            }}
          >
            <p style={{ fontSize: 11, fontWeight: 600, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
              Versions
            </p>
            <span style={{
              background: versionsOpen ? "none" : "#8B1A1A",
              color: versionsOpen ? "#aaa" : "#fff",
              borderRadius: "6px",
              padding: versionsOpen ? "0" : "4px 8px",
              fontSize: 12,
              fontWeight: 500,
            }}>
              {versionsOpen ? "▲ Hide" : "▼ Show versions"}
            </span>
          </button>

          <div className={`versions-list ${versionsOpen ? "open" : "closed"}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {/* Original tab */}
              {versions[0]?.original_image_url && (
                <button
                  onClick={() => { setShowOriginal(true); setSelectedVersionId(null); if (window.innerWidth < 768) setVersionsOpen(false); }}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "10px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                    background: showOriginal ? "rgba(139,26,26,0.08)" : "transparent",
                    color: showOriginal ? "#8B1A1A" : "#4A4A4A",
                    fontWeight: showOriginal ? 600 : 400, fontSize: 13,
                  }}
                >
                  Original upload
                </button>
              )}

              {versions.map((v) => (
                <button
                  key={v.floor_plan_id}
                  onClick={() => handleVersionSelect(v.floor_plan_id)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "10px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                    background: selectedVersionId === v.floor_plan_id && !showOriginal ? "rgba(139,26,26,0.08)" : "transparent",
                    color: selectedVersionId === v.floor_plan_id && !showOriginal ? "#8B1A1A" : "#4A4A4A",
                    fontWeight: selectedVersionId === v.floor_plan_id && !showOriginal ? 600 : 400,
                    fontSize: 13,
                  }}
                >
                  <span>v{v.version}</span>
                  {v.is_latest && (
                    <span style={{ marginLeft: 6, background: "#E8F5E9", color: "#2E7D32", fontSize: 10, borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>
                      Latest
                    </span>
                  )}
                  <br />
                  <span style={{ fontSize: 11, color: "#aaa", fontWeight: 400 }}>
                    {formatDate(v.uploaded_at)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Floor plan + details */}
        <div className="apt-detail-canvas">
          {/* Original image view */}
          {showOriginal && versions[0]?.original_image_url && (
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: "#4A4A4A", marginBottom: 12 }}>
                Original uploaded image
              </h3>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={buildImageUrl(versions[0].original_image_url)}
                alt="Original floor plan"
                style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid #eee" }}
              />
            </div>
          )}

          {/* Version detail view */}
          {!showOriginal && (detailLoading ? (
            <div style={{ textAlign: "center", paddingTop: 40, color: "#aaa" }}>Loading…</div>
          ) : detail ? (
            <div>
              {/* Floor plan canvas */}
              {canvasImageUrl ? (
                <div style={{ marginBottom: 20 }}>
                  <FloorPlanCanvas
                    key={selectedVersionId ?? "none"}
                    imageUrl={canvasImageUrl}
                    rooms={canvasRooms}
                  />
                </div>
              ) : (
                <div style={{
                  marginBottom: 20, padding: "40px 0", textAlign: "center",
                  color: "#aaa", fontSize: 13, background: "#fafafa",
                  borderRadius: 8, border: "1px dashed #eee",
                }}>
                  No floor plan image available
                </div>
              )}

              {/* Room table */}
              <div style={{ background: "white", borderRadius: 10, border: "1px solid #eee", overflow: "hidden", marginBottom: 16 }}>
                <div style={{ padding: "14px 16px", borderBottom: "1px solid #f0f0f0" }}>
                  <h3 style={{ fontWeight: 700, fontSize: 15, color: "#4A4A4A", margin: 0 }}>Rooms</h3>
                </div>
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" } as React.CSSProperties}>
                <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#fafafa" }}>
                      {["Room", "Shape", "L × W", "Area", "Source"].map((h) => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#999", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rooms.map((r, i) => {
                      const isExpanded = expandedRoomIds.includes(r.id);
                      const m = (r.shape as { measurement?: {
                        values?: Record<string, number>;
                        labels?: Record<string, string>;
                        shape_class?: string;
                      } } | null)?.measurement;
                      const hasMeasurements = m && m.values && Object.keys(m.values).length > 0;
                      
                      return (
                        <React.Fragment key={r.id}>
                          <tr
                            onClick={() => hasMeasurements && toggleRoomExpanded(r.id)}
                            style={{
                              borderTop: "1px solid #f5f5f5",
                              background: r.is_balcony ? "#FFF8F0" : i % 2 === 0 ? "white" : "#fafafa",
                              cursor: hasMeasurements ? "pointer" : "default",
                            }}
                          >
                            <td style={{ padding: "10px 12px", fontWeight: 500, color: "#4A4A4A", whiteSpace: "nowrap" }}>
                              {r.room_name}
                              {r.is_balcony && (
                                <span style={{ marginLeft: 6, fontSize: 10, background: "#FFE0B2", color: "#E65100", borderRadius: 4, padding: "1px 5px" }}>
                                  Exterior
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "10px 12px", color: "#666", textTransform: "capitalize", whiteSpace: "nowrap" }}>
                              {(r.shape as { mode?: string } | null)?.mode ?? "Rectangle"}
                            </td>
                            <td style={{ padding: "10px 12px", color: "#666", whiteSpace: "nowrap" }}>
                              {r.length_m > 0 && r.width_m > 0 ? (
                                `${r.length_m} × ${r.width_m} m`
                              ) : hasMeasurements ? (
                                <span style={{ fontSize: 11, color: "#8B1A1A", display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                                  {Object.keys(m.values || {}).length} sides
                                  <span>{isExpanded ? "▾" : "▸"}</span>
                                </span>
                              ) : (
                                <span style={{ color: "#aaa" }}>—</span>
                              )}
                            </td>
                            <td style={{ padding: "10px 12px", fontWeight: 700, color: "#8B1A1A", whiteSpace: "nowrap" }}>
                              {r.area_m2} m²
                            </td>
                            <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                              <span
                                style={{
                                  fontSize: 11,
                                  borderRadius: 4,
                                  padding: "2px 7px",
                                  fontWeight: 600,
                                  background: r.source === "ai" ? "#E3F2FD" : "#F3E5F5",
                                  color: r.source === "ai" ? "#1565C0" : "#6A1B9A",
                                }}
                              >
                                {r.source === "ai" ? "AI" : "You"}
                              </span>
                            </td>
                          </tr>
                          {isExpanded && hasMeasurements && (
                            <tr style={{ background: r.is_balcony ? "#FFFDFB" : "#FBFBFB" }}>
                              <td colSpan={5} style={{ padding: "10px 16px 12px 24px", borderTop: "1px solid #f5f5f5" }}>
                                <div style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
                                  gap: "8px 16px",
                                  background: "#fdfdfd",
                                  padding: "10px 14px",
                                  borderRadius: 8,
                                  border: "1px solid #f0f0f0"
                                }}>
                                  {Object.entries(m.values || {}).map(([id, val]) => (
                                    <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, borderBottom: "1px solid #eee", paddingBottom: 4 }}>
                                      <span style={{ color: "#777", marginRight: 8 }}>{m.labels?.[id] || id}:</span>
                                      <span style={{ fontWeight: 600, color: "#4A4A4A" }}>{val} m</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>

              {/* Totals */}
              <div style={{ background: "#F5E8E8", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ color: "#8B1A1A", fontSize: 13 }}>Internal</span>
                  <span style={{ color: "#8B1A1A", fontWeight: 700, fontSize: 15 }}>
                    {detail.total_internal_m2 ?? "—"} m²
                  </span>
                </div>
                {detail.total_balcony_m2 !== null && detail.total_balcony_m2 !== undefined && detail.total_balcony_m2 > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ color: "#E65100", fontSize: 13 }}>Balcony</span>
                    <span style={{ color: "#E65100", fontWeight: 700, fontSize: 14 }}>
                      {detail.total_balcony_m2} m²
                    </span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid rgba(139,26,26,0.2)", paddingTop: 8 }}>
                  <span style={{ color: "#4A4A4A", fontWeight: 600, fontSize: 14 }}>Grand total</span>
                  <span style={{ color: "#4A4A4A", fontWeight: 800, fontSize: 16 }}>
                    {((detail.total_internal_m2 ?? 0) + (detail.total_balcony_m2 ?? 0)).toFixed(2)} m²
                  </span>
                </div>
              </div>

              {/* Metadata */}
              <div style={{ background: "white", borderRadius: 10, border: "1px solid #eee", padding: "14px 16px", marginBottom: 16 }}>
                <h4 style={{ fontWeight: 600, fontSize: 13, color: "#4A4A4A", marginBottom: 10, marginTop: 0 }}>Details</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontSize: 13 }}>
                  <div>
                    <p style={{ color: "#aaa", fontSize: 11, margin: "0 0 2px" }}>Uploaded by</p>
                    <p style={{ color: "#4A4A4A", margin: 0, fontWeight: 500 }}>{detail.uploaded_by_email ?? "—"}</p>
                  </div>
                  <div>
                    <p style={{ color: "#aaa", fontSize: 11, margin: "0 0 2px" }}>Date</p>
                    <p style={{ color: "#4A4A4A", margin: 0 }}>{formatDateTime(detail.uploaded_at)}</p>
                  </div>
                  <div>
                    <p style={{ color: "#aaa", fontSize: 11, margin: "0 0 2px" }}>AI confidence</p>
                    <p style={{ color: "#4A4A4A", margin: 0 }}>
                      {detail.ai_confidence_score ? `${Math.round(detail.ai_confidence_score * 100)}%` : "—"}
                    </p>
                  </div>
                  <div>
                    <p style={{ color: "#aaa", fontSize: 11, margin: "0 0 2px" }}>Device</p>
                    <p style={{ color: "#4A4A4A", margin: 0, textTransform: "capitalize" }}>{detail.device_type ?? "—"}</p>
                  </div>
                </div>
              </div>

              {/* Edit button */}
              <button
                onClick={() => setEditModalOpen(true)}
                style={{
                  background: "white",
                  border: "2px solid #8B1A1A",
                  color: "#8B1A1A",
                  borderRadius: 8,
                  padding: "10px 20px",
                  fontWeight: 600,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Edit this version
              </button>
            </div>
          ) : null)}
        </div>
      </div>

      {/* Edit version modal */}
      {editModalOpen && (
        <div
          onClick={() => setEditModalOpen(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            zIndex: 100, padding: "0 0 24px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white", borderRadius: 16, padding: "24px 20px",
              width: "100%", maxWidth: 430, display: "flex", flexDirection: "column", gap: 12,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#4A4A4A" }}>Edit this version</h3>
            <p style={{ margin: 0, fontSize: 13, color: "#888" }}>What would you like to update?</p>

            <button
              onClick={() => {
                if (!detail) return;
                ["review_completed", "measurements_draft", "came_from_measure", "specified_rooms", "upload_result", "confirm_data"].forEach(
                  (key) => sessionStorage.removeItem(key)
                );
                const reviewData = {
                  upload_id: null,
                  apartment_name: detail.apartment_name,
                  image_url: detail.image_url,
                  original_image_url: detail.original_image_url,
                  thumbnail_url: detail.thumbnail_url,
                  rooms: detail.rooms.map((r) => ({
                    room_name: r.room_name,
                    is_balcony: r.is_balcony,
                    confidence: 0.9,
                    bbox: r.bbox,
                    source: r.source ?? "ai",
                    sort_order: r.sort_order,
                    shape: r.shape,
                  })),
                };
                sessionStorage.setItem("review_result", JSON.stringify(reviewData));
                const draft = Object.fromEntries(
                  detail.rooms.map((r) => [r.room_name, { length_m: String(r.length_m), width_m: String(r.width_m) }])
                );
                sessionStorage.setItem("measurements_draft", JSON.stringify(draft));
                sessionStorage.setItem("upload_for_apartment", JSON.stringify({ apartment_id: id, apartment_name: detail.apartment_name }));
                setEditModalOpen(false);
                router.push("/measure");
              }}
              style={{
                background: "#8B1A1A", color: "white", border: "none",
                borderRadius: 10, padding: "14px 16px", fontWeight: 600,
                fontSize: 14, cursor: "pointer", textAlign: "left",
              }}
            >
              <div>Update measurements only</div>
              <div style={{ fontSize: 12, fontWeight: 400, opacity: 0.8, marginTop: 3 }}>
                Keep room positions, edit lengths and widths
              </div>
            </button>

            <button
              onClick={() => {
                if (!detail) return;
                clearFlowSession();
                const syntheticUpload = {
                  upload_id: null,
                  image_url: detail.image_url,
                  original_image_url: detail.original_image_url,
                  thumbnail_url: detail.thumbnail_url,
                  apartment_name: detail.apartment_name,
                  rooms: detail.rooms.map((r) => ({
                    room_name: r.room_name,
                    is_balcony: r.is_balcony,
                    confidence: 0.9,
                    bbox: r.bbox,
                  })),
                };
                sessionStorage.setItem("upload_result", JSON.stringify(syntheticUpload));
                sessionStorage.setItem("specified_rooms", JSON.stringify(
                  detail.rooms.map((r) => ({ room_name: r.room_name, is_balcony: r.is_balcony }))
                ));
                sessionStorage.setItem("upload_for_apartment", JSON.stringify({ apartment_id: id, apartment_name: detail.apartment_name }));
                setEditModalOpen(false);
                router.push("/review");
              }}
              style={{
                background: "white", color: "#4A4A4A",
                border: "2px solid #ddd", borderRadius: 10,
                padding: "14px 16px", fontWeight: 600,
                fontSize: 14, cursor: "pointer", textAlign: "left",
              }}
            >
              <div>Re-draw room positions</div>
              <div style={{ fontSize: 12, fontWeight: 400, color: "#888", marginTop: 3 }}>
                Adjust where rooms are drawn on the floor plan
              </div>
            </button>

            <button
              onClick={() => setEditModalOpen(false)}
              style={{
                background: "none", border: "none", color: "#aaa",
                fontSize: 14, cursor: "pointer", padding: "8px 0",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </AppShell>
    </div>
  );
}
