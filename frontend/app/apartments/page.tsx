"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { getApartments, type ApartmentListItem } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

export default function ApartmentsPage() {
  const router = useRouter();
  const [apartments, setApartments] = useState<ApartmentListItem[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getApartments()
      .then(setApartments)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = apartments.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.address ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AppShell activePath="/apartments">
      <div style={{ padding: "28px 28px 16px", background: "#fff", borderBottom: "1px solid #eee" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#4A4A4A", margin: 0 }}>Floor plans</h1>
          <button
            onClick={() => router.push("/upload")}
            style={{
              background: "#8B1A1A",
              color: "white",
              border: "none",
              borderRadius: 8,
              padding: "8px 16px",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            + New floor plan
          </button>
        </div>
        <input
          type="text"
          placeholder="Search by name or address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            height: 40,
            border: "1px solid #e0e0e0",
            borderRadius: 8,
            padding: "0 14px",
            fontSize: 14,
            color: "#4A4A4A",
            boxSizing: "border-box",
            outline: "none",
          }}
        />
      </div>

      <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", color: "#aaa", paddingTop: 60, fontSize: 15 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", color: "#aaa", paddingTop: 60, fontSize: 15 }}>
            {search ? "No matches found." : "No floor plans yet. Upload your first one!"}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {filtered.map((apt) => (
              <div
                key={apt.apartment_id}
                onClick={() => router.push(`/apartments/${apt.apartment_id}`)}
                style={{
                  background: "white",
                  borderRadius: 12,
                  border: "1px solid #eee",
                  overflow: "hidden",
                  cursor: "pointer",
                  transition: "box-shadow 0.15s",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.12)")}
                onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.05)")}
              >
                {/* Thumbnail */}
                <div
                  style={{
                    height: 140,
                    background: "#F5F5F5",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {apt.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${API_URL}${apt.thumbnail_url}`}
                      alt={apt.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : apt.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`${API_URL}${apt.image_url}`}
                      alt={apt.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <path d="M3 9h18M9 21V9"/>
                    </svg>
                  )}
                </div>

                {/* Info */}
                <div style={{ padding: "14px 16px" }}>
                  <p style={{ fontWeight: 700, fontSize: 15, color: "#4A4A4A", margin: "0 0 2px" }}>{apt.name}</p>
                  {apt.address && (
                    <p style={{ fontSize: 12, color: "#888", margin: "0 0 10px" }}>{apt.address}</p>
                  )}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    {apt.total_internal_m2 && (
                      <span
                        style={{
                          background: "#F5E8E8",
                          color: "#8B1A1A",
                          fontSize: 12,
                          fontWeight: 700,
                          borderRadius: 6,
                          padding: "2px 8px",
                        }}
                      >
                        {apt.total_internal_m2} m²
                      </span>
                    )}
                    {apt.room_count && (
                      <span
                        style={{
                          background: "#F0F0F0",
                          color: "#666",
                          fontSize: 12,
                          borderRadius: 6,
                          padding: "2px 8px",
                        }}
                      >
                        {apt.room_count} rooms
                      </span>
                    )}
                    {apt.latest_version && (
                      <span
                        style={{
                          background: "#E8F5E9",
                          color: "#2E7D32",
                          fontSize: 12,
                          borderRadius: 6,
                          padding: "2px 8px",
                        }}
                      >
                        v{apt.latest_version}
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 11, color: "#aaa", margin: 0 }}>
                    Updated {formatDate(apt.uploaded_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
