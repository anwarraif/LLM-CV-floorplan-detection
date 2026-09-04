"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { getUser } from "@/lib/auth";
import {
  getAdminReportsSummary,
  getServerMonitoringStatus,
  triggerServerMonitoringReport,
  downloadAdminReportsCsv,
  type AdminReportsSummary,
  type ServerMonitoringStatus,
} from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ReportsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reportsData, setReportsData] = useState<AdminReportsSummary | null>(null);
  const [serverMetrics, setServerMetrics] = useState<ServerMonitoringStatus | null>(null);
  const [error, setError] = useState("");
  const [telegramSending, setTelegramSending] = useState(false);
  const [telegramMsg, setTelegramMsg] = useState("");
  const [exportingCsv, setExportingCsv] = useState(false);

  async function loadData() {
    try {
      setError("");
      const [reports, metrics] = await Promise.all([
        getAdminReportsSummary(),
        getServerMonitoringStatus().catch(() => null),
      ]);
      setReportsData(reports);
      setServerMetrics(metrics);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load report data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const user = getUser();
    if (!user || user.role !== "admin") {
      router.replace("/apartments");
      return;
    }
    loadData();
  }, [router]);

  async function handleRefresh() {
    setRefreshing(true);
    await loadData();
  }

  async function handleExportCsv() {
    try {
      setExportingCsv(true);
      await downloadAdminReportsCsv();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to download CSV.");
    } finally {
      setExportingCsv(false);
    }
  }

  async function handleTriggerTelegram() {
    try {
      setTelegramSending(true);
      setTelegramMsg("");
      const res = await triggerServerMonitoringReport();
      setTelegramMsg(res.message || "Report sent successfully to Telegram!");
      setTimeout(() => setTelegramMsg(""), 6000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to send Telegram report.");
    } finally {
      setTelegramSending(false);
    }
  }

  const stats = reportsData?.stats;
  const ai = reportsData?.ai_metrics;

  return (
    <AppShell activePath="/reports">
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 24px 60px" }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: "#2A2A2A" }}>
                Reports & Analytics
              </h1>
              <span
                style={{
                  background: "#8B1A1A",
                  color: "#ffffff",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 8px",
                  borderRadius: 6,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                Admin Only
              </span>
            </div>
            <p style={{ margin: "6px 0 0", color: "#666", fontSize: 14 }}>
              Comprehensive performance metrics, AI accuracy insights, agent activity, and system health.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={handleRefresh}
              disabled={refreshing || loading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "9px 14px",
                background: "#ffffff",
                border: "1px solid #D1D5DB",
                borderRadius: 8,
                color: "#374151",
                fontSize: 13,
                fontWeight: 600,
                cursor: refreshing || loading ? "not-allowed" : "pointer",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>

            <button
              onClick={handleExportCsv}
              disabled={exportingCsv || loading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "9px 16px",
                background: "#8B1A1A",
                border: "none",
                borderRadius: 8,
                color: "#ffffff",
                fontSize: 13,
                fontWeight: 600,
                cursor: exportingCsv || loading ? "not-allowed" : "pointer",
                boxShadow: "0 2px 4px rgba(139,26,26,0.2)",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              {exportingCsv ? "Exporting…" : "Export CSV"}
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              background: "#FEE2E2",
              border: "1px solid #FCA5A5",
              color: "#991B1B",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 24,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        {telegramMsg && (
          <div
            style={{
              background: "#DEF7EC",
              border: "1px solid #31C48D",
              color: "#03543F",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 24,
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>✓</span> {telegramMsg}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#888" }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
            <p style={{ margin: 0, fontSize: 14 }}>Loading analytics & reports summary…</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            {/* Top KPI Cards */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 16,
              }}
            >
              {/* Total Floor Plans */}
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 12,
                  padding: "20px 22px",
                  border: "1px solid #E5E7EB",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#6B7280" }}>Total Floor Plans</span>
                  <span
                    style={{
                      background: "#F3F4F6",
                      color: "#374151",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    All time
                  </span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginTop: 8 }}>
                  {stats?.total_floor_plans ?? 0}
                </div>
                <div style={{ fontSize: 12, color: "#059669", marginTop: 6, fontWeight: 500 }}>
                  +{stats?.floor_plans_this_month ?? 0} uploaded this month
                </div>
              </div>

              {/* Active Apartments */}
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 12,
                  padding: "20px 22px",
                  border: "1px solid #E5E7EB",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#6B7280" }}>Active Apartments</span>
                  <span
                    style={{
                      background: "#EEF2FF",
                      color: "#4338CA",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    Properties
                  </span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginTop: 8 }}>
                  {stats?.total_apartments ?? 0}
                </div>
                <div style={{ fontSize: 12, color: "#6B7280", marginTop: 6 }}>
                  {reportsData?.total_rooms ?? 0} total rooms catalogued
                </div>
              </div>

              {/* AI Confidence Score */}
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 12,
                  padding: "20px 22px",
                  border: "1px solid #E5E7EB",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#6B7280" }}>AI Avg Confidence</span>
                  <span
                    style={{
                      background: "#ECFDF5",
                      color: "#065F46",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    Vision Model
                  </span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginTop: 8 }}>
                  {ai?.avg_confidence_score ? `${(ai.avg_confidence_score * 100).toFixed(1)}%` : "N/A"}
                </div>
                <div style={{ fontSize: 12, color: "#6B7280", marginTop: 6 }}>
                  {ai?.flagged_count ?? 0} plans with warning flags
                </div>
              </div>

              {/* Human Edit Rate */}
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 12,
                  padding: "20px 22px",
                  border: "1px solid #E5E7EB",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#6B7280" }}>Human Edit Rate</span>
                  <span
                    style={{
                      background: ai?.edit_rate_percent && ai.edit_rate_percent > 40 ? "#FEF3C7" : "#F3F4F6",
                      color: ai?.edit_rate_percent && ai.edit_rate_percent > 40 ? "#92400E" : "#374151",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    Intervention
                  </span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginTop: 8 }}>
                  {ai?.edit_rate_percent ?? 0}%
                </div>
                <div style={{ fontSize: 12, color: "#6B7280", marginTop: 6 }}>
                  {ai?.unedited_count ?? 0} auto-approved / {ai?.edited_count ?? 0} adjusted
                </div>
              </div>
            </div>

            {/* AI Performance & Dimensional Averages */}
            <div
              style={{
                background: "#ffffff",
                borderRadius: 12,
                padding: "24px",
                border: "1px solid #E5E7EB",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1F2937" }}>
                    AI Detection Quality & Dimensional Breakdown
                  </h2>
                  <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
                    Comparison between direct AI pass-through and manual human refinement.
                  </p>
                </div>
              </div>

              {/* Progress visual bar */}
              <div style={{ marginTop: 12, marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  <span style={{ color: "#059669" }}>
                    ● 100% AI Passthrough (No Edits): {ai?.unedited_count ?? 0} ({100 - (ai?.edit_rate_percent ?? 0)}%)
                  </span>
                  <span style={{ color: "#D97706" }}>
                    ● Human Corrected: {ai?.edited_count ?? 0} ({ai?.edit_rate_percent ?? 0}%)
                  </span>
                </div>
                <div
                  style={{
                    height: 12,
                    borderRadius: 6,
                    background: "#F3F4F6",
                    overflow: "hidden",
                    display: "flex",
                  }}
                >
                  <div
                    style={{
                      width: `${100 - (ai?.edit_rate_percent ?? 0)}%`,
                      background: "#10B981",
                      transition: "width 0.4s ease",
                    }}
                  />
                  <div
                    style={{
                      width: `${ai?.edit_rate_percent ?? 0}%`,
                      background: "#F59E0B",
                      transition: "width 0.4s ease",
                    }}
                  />
                </div>
              </div>

              {/* Mini cards */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 14,
                  marginTop: 16,
                }}
              >
                <div style={{ background: "#F9FAFB", padding: "14px 16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                  <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 500 }}>Avg Internal Area</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#1F2937", marginTop: 4 }}>
                    {ai?.avg_internal_m2 ? `${ai.avg_internal_m2} m²` : "N/A"}
                  </div>
                </div>
                <div style={{ background: "#F9FAFB", padding: "14px 16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                  <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 500 }}>Avg Balcony Area</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#1F2937", marginTop: 4 }}>
                    {ai?.avg_balcony_m2 ? `${ai.avg_balcony_m2} m²` : "N/A"}
                  </div>
                </div>
                <div style={{ background: "#F9FAFB", padding: "14px 16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                  <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 500 }}>Flagged Plans</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#DC2626", marginTop: 4 }}>
                    {ai?.flagged_count ?? 0}
                  </div>
                </div>
                <div style={{ background: "#F9FAFB", padding: "14px 16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                  <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 500 }}>Active Users</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#1F2937", marginTop: 4 }}>
                    {stats?.active_users ?? 0} / {stats?.total_users ?? 0}
                  </div>
                </div>
              </div>
            </div>

            {/* Agent Activity & Productivity */}
            <div
              style={{
                background: "#ffffff",
                borderRadius: 12,
                padding: "24px",
                border: "1px solid #E5E7EB",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1F2937" }}>
                    Agent Activity & Productivity
                  </h2>
                  <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
                    Overview of floor plan uploads and edits by each registered user.
                  </p>
                </div>
                <Link
                  href="/admin"
                  style={{
                    fontSize: 13,
                    color: "#8B1A1A",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  Manage Users →
                </Link>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #E5E7EB", color: "#6B7280" }}>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>User / Agent</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Role</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Status</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600, textAlign: "right" }}>Uploads</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600, textAlign: "right" }}>Edits</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Last Login</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(reportsData?.agent_productivity ?? []).map((agent) => (
                      <tr key={agent.user_id} style={{ borderBottom: "1px solid #F3F4F6" }}>
                        <td style={{ padding: "12px 12px" }}>
                          <div style={{ fontWeight: 600, color: "#111827" }}>
                            {agent.full_name || "Unnamed"}
                          </div>
                          <div style={{ fontSize: 12, color: "#6B7280" }}>{agent.email}</div>
                        </td>
                        <td style={{ padding: "12px 12px" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              background: agent.role === "admin" ? "#8B1A1A" : "#E5E7EB",
                              color: agent.role === "admin" ? "#ffffff" : "#374151",
                            }}
                          >
                            {agent.role}
                          </span>
                        </td>
                        <td style={{ padding: "12px 12px" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              background: agent.is_active ? "#ECFDF5" : "#FEE2E2",
                              color: agent.is_active ? "#065F46" : "#991B1B",
                            }}
                          >
                            {agent.is_active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td style={{ padding: "12px 12px", textAlign: "right", fontWeight: 600, color: "#111827" }}>
                          {agent.floor_plans_uploaded}
                        </td>
                        <td style={{ padding: "12px 12px", textAlign: "right", color: "#6B7280" }}>
                          {agent.floor_plans_edited}
                        </td>
                        <td style={{ padding: "12px 12px", color: "#6B7280" }}>
                          {formatDate(agent.last_login)}
                        </td>
                      </tr>
                    ))}
                    {(reportsData?.agent_productivity ?? []).length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: "24px", textAlign: "center", color: "#9CA3AF" }}>
                          No agent activity recorded yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent Uploads Stream */}
            <div
              style={{
                background: "#ffffff",
                borderRadius: 12,
                padding: "24px",
                border: "1px solid #E5E7EB",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1F2937" }}>
                    Recent Floor Plan Uploads
                  </h2>
                  <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
                    Latest floor plans uploaded and processed by the system.
                  </p>
                </div>
                <Link
                  href="/apartments"
                  style={{
                    fontSize: 13,
                    color: "#8B1A1A",
                    fontWeight: 600,
                    textDecoration: "none",
                  }}
                >
                  View All Floor Plans →
                </Link>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, textAlign: "left" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #E5E7EB", color: "#6B7280" }}>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Apartment</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Version</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Uploaded By</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Total Area</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>AI Conf.</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Status</th>
                      <th style={{ padding: "10px 12px", fontWeight: 600 }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(reportsData?.recent_activity ?? []).map((item) => {
                      const totalArea =
                        (item.total_internal_m2 || 0) + (item.total_balcony_m2 || 0);
                      return (
                        <tr key={item.floor_plan_id} style={{ borderBottom: "1px solid #F3F4F6" }}>
                          <td style={{ padding: "12px 12px", fontWeight: 600, color: "#111827" }}>
                            <Link
                              href={`/apartments/${item.apartment_id}`}
                              style={{ color: "#111827", textDecoration: "none" }}
                            >
                              {item.apartment_name}
                            </Link>
                          </td>
                          <td style={{ padding: "12px 12px", color: "#6B7280" }}>v{item.version}</td>
                          <td style={{ padding: "12px 12px", color: "#6B7280" }}>
                            {item.uploaded_by_email || "System"}
                          </td>
                          <td style={{ padding: "12px 12px", color: "#111827", fontWeight: 500 }}>
                            {totalArea > 0 ? `${totalArea.toFixed(2)} m²` : "—"}
                          </td>
                          <td style={{ padding: "12px 12px", color: "#6B7280" }}>
                            {item.ai_confidence_score
                              ? `${(item.ai_confidence_score * 100).toFixed(0)}%`
                              : "—"}
                          </td>
                          <td style={{ padding: "12px 12px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                borderRadius: 4,
                                fontSize: 11,
                                fontWeight: 600,
                                background: item.was_edited ? "#FEF3C7" : "#ECFDF5",
                                color: item.was_edited ? "#92400E" : "#065F46",
                              }}
                            >
                              {item.was_edited ? "Edited" : "Direct AI"}
                            </span>
                          </td>
                          <td style={{ padding: "12px 12px", color: "#6B7280", whiteSpace: "nowrap" }}>
                            {formatDate(item.uploaded_at)}
                          </td>
                        </tr>
                      );
                    })}
                    {(reportsData?.recent_activity ?? []).length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ padding: "24px", textAlign: "center", color: "#9CA3AF" }}>
                          No recent floor plan activity found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Server & Infrastructure Health Panel */}
            <div
              style={{
                background: "#ffffff",
                borderRadius: 12,
                padding: "24px",
                border: "1px solid #E5E7EB",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  marginBottom: 18,
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#1F2937" }}>
                    Server & System Health Monitoring
                  </h2>
                  <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6B7280" }}>
                    Live server resource metrics, storage allocation, and service connectivity.
                  </p>
                </div>

                <button
                  onClick={handleTriggerTelegram}
                  disabled={telegramSending}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 14px",
                    background: "#0088CC",
                    border: "none",
                    borderRadius: 8,
                    color: "#ffffff",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: telegramSending ? "not-allowed" : "pointer",
                    boxShadow: "0 1px 3px rgba(0,136,204,0.3)",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.93-1.28 4.88-2.12 5.86-2.54 2.79-1.17 3.37-1.37 3.75-1.37.08 0 .27.02.39.12.1.08.13.2.14.28 0 .07.01.2 0 .28z" />
                  </svg>
                  {telegramSending ? "Sending…" : "Send Telegram Report"}
                </button>
              </div>

              {serverMetrics ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 16,
                  }}
                >
                  {/* CPU Usage */}
                  <div style={{ background: "#F9FAFB", padding: "16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}>
                      <span style={{ color: "#374151" }}>CPU Usage</span>
                      <span style={{ color: "#111827" }}>{serverMetrics.cpu_percent.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 8, background: "#E5E7EB", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, serverMetrics.cpu_percent)}%`,
                          background: serverMetrics.cpu_percent > 80 ? "#DC2626" : "#2563EB",
                        }}
                      />
                    </div>
                  </div>

                  {/* RAM Usage */}
                  <div style={{ background: "#F9FAFB", padding: "16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}>
                      <span style={{ color: "#374151" }}>Memory (RAM)</span>
                      <span style={{ color: "#111827" }}>{serverMetrics.ram_percent.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 8, background: "#E5E7EB", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, serverMetrics.ram_percent)}%`,
                          background: serverMetrics.ram_percent > 85 ? "#DC2626" : "#8B1A1A",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 6 }}>
                      {formatBytes(serverMetrics.ram_used)} / {formatBytes(serverMetrics.ram_total)}
                    </div>
                  </div>

                  {/* Disk Storage */}
                  <div style={{ background: "#F9FAFB", padding: "16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}>
                      <span style={{ color: "#374151" }}>Disk Storage</span>
                      <span style={{ color: "#111827" }}>{serverMetrics.disk_percent.toFixed(1)}%</span>
                    </div>
                    <div style={{ height: 8, background: "#E5E7EB", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, serverMetrics.disk_percent)}%`,
                          background: serverMetrics.disk_percent > 90 ? "#DC2626" : "#059669",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 6 }}>
                      {formatBytes(serverMetrics.disk_used)} / {formatBytes(serverMetrics.disk_total)}
                    </div>
                  </div>

                  {/* Services Status */}
                  <div style={{ background: "#F9FAFB", padding: "16px", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
                      Connected Services
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ color: "#6B7280" }}>Database (PostgreSQL)</span>
                        <span style={{ color: serverMetrics.db_ok ? "#059669" : "#DC2626", fontWeight: 600 }}>
                          {serverMetrics.db_ok ? "🟢 Online" : "🔴 Error"}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ color: "#6B7280" }}>Cache (Redis)</span>
                        <span style={{ color: serverMetrics.redis_ok ? "#059669" : "#DC2626", fontWeight: 600 }}>
                          {serverMetrics.redis_ok ? "🟢 Online" : "🔴 Error"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: "16px", color: "#9CA3AF", fontSize: 13, textAlign: "center" }}>
                  Server metrics unavailable or still connecting.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
