import { getToken } from "./auth";
import type { MeasurementPlan } from "./geometry";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ApartmentListItem {
  apartment_id: string;
  name: string;
  address?: string | null;
  latest_floor_plan_id?: string | null;
  latest_version?: number | null;
  total_internal_m2?: number | null;
  total_balcony_m2?: number | null;
  room_count?: number | null;
  uploaded_at?: string | null;
  image_url?: string | null;
  thumbnail_url?: string | null;
}

export interface VersionListItem {
  floor_plan_id: string;
  version: number;
  is_latest: boolean;
  total_internal_m2?: number | null;
  total_balcony_m2?: number | null;
  room_count: number;
  uploaded_at: string;
  confirmed_at?: string | null;
  uploaded_by_email?: string | null;
  image_url?: string | null;
  original_image_url?: string | null;
  thumbnail_url?: string | null;
  flags_triggered?: any[] | null;
}

export interface RoomDetail {
  id: string;
  room_name: string;
  position?: string | null;
  length_m: number;
  width_m: number;
  area_m2: number;
  is_balcony: boolean;
  sort_order: number;
  bbox?: BBox | null;
  shape?: any | null;
  source?: string | null;
}

export interface FloorPlanDetail {
  floor_plan_id: string;
  apartment_id: string;
  apartment_name: string;
  address?: string | null;
  version: number;
  is_latest: boolean;
  image_url?: string | null;
  original_image_url?: string | null;
  thumbnail_url?: string | null;
  total_internal_m2?: number | null;
  total_balcony_m2?: number | null;
  ai_confidence_score?: number | null;
  was_edited: boolean;
  device_type?: string | null;
  flags_triggered?: any[] | null;
  uploaded_at: string;
  confirmed_at?: string | null;
  uploaded_by_email?: string | null;
  rooms: RoomDetail[];
}

export interface AdminStats {
  total_users: number;
  total_apartments: number;
  total_floor_plans: number;
  active_users: number;
  floor_plans_this_month: number;
}

export interface AdminUser {
  id: string;
  email: string;
  full_name?: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
  last_login?: string | null;
}

export interface AIMetrics {
  avg_confidence_score: number | null;
  total_floor_plans: number;
  edited_count: number;
  unedited_count: number;
  edit_rate_percent: number;
  flagged_count: number;
  avg_internal_m2: number | null;
  avg_balcony_m2: number | null;
}

export interface AgentProductivityItem {
  user_id: string;
  email: string;
  full_name?: string | null;
  role: string;
  is_active: boolean;
  floor_plans_uploaded: number;
  floor_plans_edited: number;
  last_login?: string | null;
}

export interface RecentActivityItem {
  floor_plan_id: string;
  apartment_id: string;
  apartment_name: string;
  version: number;
  uploaded_at: string;
  uploaded_by_email?: string | null;
  uploaded_by_name?: string | null;
  total_internal_m2?: number | null;
  total_balcony_m2?: number | null;
  was_edited: boolean;
  ai_confidence_score?: number | null;
}

export interface MonthlyTrendItem {
  month: string;
  count: number;
}

export interface AdminReportsSummary {
  stats: AdminStats;
  ai_metrics: AIMetrics;
  agent_productivity: AgentProductivityItem[];
  recent_activity: RecentActivityItem[];
  monthly_trend: MonthlyTrendItem[];
  total_rooms: number;
}

export interface ServerMonitoringStatus {
  cpu_percent: number;
  ram_total: number;
  ram_used: number;
  ram_free: number;
  ram_percent: number;
  disk_total: number;
  disk_used: number;
  disk_free: number;
  disk_percent: number;
  db_ok: boolean;
  redis_ok: boolean;
  total_users: number;
  total_apartments: number;
  total_floor_plans: number;
}

export interface UploadResponse {
  upload_id: string;
  image_url: string;
  original_image_url?: string | null;
  thumbnail_url?: string | null;
  apartment_name?: string | null;
  confidence: number;
  rooms: Array<{
    room_name: string;
    is_balcony: boolean;
    confidence: number;
    bbox?: BBox | null;
    shape_type?: string;
    polygon_points?: Array<{ x: number; y: number }> | null;
  }>;
  original_filename: string;
  file_type: string;
  floor_plan_boundary?: BBox | null;
  floor_plan_orientation?: string | null;
}

export interface SaveFloorPlanPayload {
  upload_id?: string;
  apartment_id?: string;
  apartment_name: string;
  address?: string;
  image_url?: string;
  original_image_url?: string;
  thumbnail_url?: string;
  rooms: Array<{
    room_name: string;
    is_balcony: boolean;
    length_m: number;
    width_m: number;
    area_m2?: number;
    sort_order: number;
    bbox?: BBox | null;
    shape?: any | null;
  }>;
  was_edited?: boolean;
  device_type?: string;
  confirmed_flags?: string[];
}

// ── HTTP Request Helper ──────────────────────────────────────────────────────

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // Skip ngrok browser warning for API requests
  headers.set("ngrok-skip-browser-warning", "true");

  // Fetch's browser built-in behavior naturally sets correct boundary headers for FormData,
  // so we must not manually specify Content-Type if the body is FormData.
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    if (typeof window !== "undefined") {
      document.cookie = "apt_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      localStorage.removeItem("apt_user");
      window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname);
    }
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message = errorBody.detail || response.statusText || "Request failed";
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return response.json() as Promise<T>;
}

// ── Auth Endpoints ───────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  return request<{
    access_token: string;
    token_type: string;
    user_id: string;
    email: string;
    full_name: string | null;
    role: string;
  }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function forgotPassword(email: string) {
  return request<{ message: string }>("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function verifyOtp(email: string, otp: string) {
  return request<{ message: string }>("/api/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp }),
  });
}

export async function resetPassword(email: string, otp: string, newPassword: string) {
  return request<{ message: string }>("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ email, otp, new_password: newPassword }),
  });
}

// ── Upload Endpoints ─────────────────────────────────────────────────────────

export async function uploadFloorPlan(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return request<UploadResponse>("/api/upload", {
    method: "POST",
    body: formData,
  });
}

export async function locateRooms(
  imageUrl: string,
  rooms: Array<{ room_name: string; is_balcony: boolean }>,
  knownRooms: Array<{
    room_name: string;
    is_balcony: boolean;
    bbox: BBox | null;
    confidence?: number;
    shape_type?: string;
    polygon_points?: Array<{ x: number; y: number }> | null;
  }> = [],
  orientation: string = "axis-aligned"
) {
  return request<{
    rooms: Array<{
      room_name: string;
      is_balcony: boolean;
      confidence: number;
      bbox: BBox | null;
      shape_type: string;
      polygon_points?: Array<{ x: number; y: number }> | null;
    }>;
  }>("/api/upload/locate-rooms", {
    method: "POST",
    body: JSON.stringify({
      image_url: imageUrl,
      rooms: rooms.map(r => ({ room_name: r.room_name, is_balcony: r.is_balcony })),
      known_rooms: knownRooms.map(kr => ({
        room_name: kr.room_name,
        is_balcony: kr.is_balcony,
        bbox: kr.bbox,
        confidence: kr.confidence,
        shape_type: kr.shape_type,
        polygon_points: kr.polygon_points,
      })),
      orientation,
    }),
  });
}

// ── Floor Plan & Apartment Endpoints ───────────────────────────────────────────

export async function saveFloorPlan(payload: SaveFloorPlanPayload) {
  return request<{
    floor_plan_id: string;
    apartment_id: string;
    apartment_name: string;
    version: number;
    rooms: RoomDetail[];
    total_internal_m2: number;
    total_balcony_m2: number;
    total_m2: number;
    flags: any[];
    saved_at: string;
    name_mismatch?: {
      existing_name: string;
      detected_name: string;
      similarity: number;
    } | null;
    similarity_match?: {
      apartment_id: string;
      apartment_name: string;
      similarity: number;
    } | null;
  }>("/api/floorplan/save", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getMeasurementPlan(
  polygonPoints: Array<{ x: number; y: number }>,
  aspectRatio: number
) {
  return request<MeasurementPlan>("/api/floorplan/measurement-plan", {
    method: "POST",
    body: JSON.stringify({ polygon_points: polygonPoints, aspect_ratio: aspectRatio }),
  });
}

export async function checkApartmentSimilarity(name: string) {
  return request<{
    similarity_match: {
      apartment_id: string;
      apartment_name: string;
      similarity: number;
    } | null;
    auto_match_apartment_id?: string | null;
  }>(`/api/floorplan/check-similarity?name=${encodeURIComponent(name)}`, {
    method: "GET",
  });
}

export async function reassignFloorPlan(floorPlanId: string, apartmentName: string) {
  return request<{
    success: boolean;
    new_apartment_id: string;
    new_apartment_name: string;
  }>(`/api/floorplan/${floorPlanId}/reassign`, {
    method: "POST",
    body: JSON.stringify({ apartment_name: apartmentName }),
  });
}

export async function getApartments() {
  return request<ApartmentListItem[]>("/api/apartments", {
    method: "GET",
  });
}

export async function getApartmentVersions(apartmentId: string) {
  return request<VersionListItem[]>(`/api/apartments/${apartmentId}/versions`, {
    method: "GET",
  });
}

export async function getApartmentVersion(apartmentId: string, floorPlanId: string) {
  return request<FloorPlanDetail>(`/api/apartments/${apartmentId}/versions/${floorPlanId}`, {
    method: "GET",
  });
}

// ── Admin Endpoints ──────────────────────────────────────────────────────────

export async function getAdminStats() {
  return request<AdminStats>("/api/admin/stats", {
    method: "GET",
  });
}

export async function getAdminUsers() {
  return request<AdminUser[]>("/api/admin/users", {
    method: "GET",
  });
}

export async function createAdminUser(payload: {
  email: string;
  password?: string;
  full_name?: string;
  role: string;
}) {
  return request<AdminUser>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateAdminUser(
  userId: string,
  payload: {
    full_name?: string;
    role?: string;
    is_active?: boolean;
  }
) {
  return request<AdminUser>(`/api/admin/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function getAdminReportsSummary() {
  return request<AdminReportsSummary>("/api/admin/reports/summary", {
    method: "GET",
  });
}

export async function getServerMonitoringStatus() {
  return request<ServerMonitoringStatus>("/api/admin/server-monitoring/status", {
    method: "GET",
  });
}

export async function triggerServerMonitoringReport() {
  return request<{ message: string }>("/api/admin/server-monitoring/trigger", {
    method: "POST",
  });
}

export async function downloadAdminReportsCsv() {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/admin/reports/export-csv`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "ngrok-skip-browser-warning": "true",
    },
  });
  if (!res.ok) {
    throw new Error("Failed to download CSV report");
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `floorplans_report_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

