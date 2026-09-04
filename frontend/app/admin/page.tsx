"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { getUser } from "@/lib/auth";
import {
  getAdminStats,
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  type AdminStats,
  type AdminUser,
} from "@/lib/api";

function generatePassword(len = 12): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

interface AddUserModalProps {
  onClose: () => void;
  onCreated: (user: AdminUser) => void;
}

function AddUserModal({ onClose, onCreated }: AddUserModalProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"agent" | "admin">("agent");
  const [password] = useState(generatePassword());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleCreate() {
    setError("");
    if (!email.trim()) { setError("Email is required."); return; }
    setLoading(true);
    try {
      const user = await createAdminUser({ email: email.trim(), password, full_name: name.trim() || undefined, role });
      setDone(true);
      onCreated(user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create user.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "white", borderRadius: 12, width: "100%", maxWidth: 420, padding: 24, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#4A4A4A" }}>Add user</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#aaa", lineHeight: 1 }}>×</button>
        </div>

        {done ? (
          <div>
            <div style={{ background: "#F5E8E8", borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <p style={{ margin: "0 0 6px", fontWeight: 600, color: "#8B1A1A", fontSize: 14 }}>User created! Share this password once:</p>
              <p style={{ margin: 0, fontFamily: "monospace", fontSize: 16, color: "#4A4A4A", letterSpacing: "0.08em" }}>{password}</p>
            </div>
            <button onClick={onClose} style={{ width: "100%", height: 42, borderRadius: 8, background: "#8B1A1A", color: "white", border: "none", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
              Done
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {error && <p style={{ background: "#FEE", borderRadius: 6, padding: "8px 12px", color: "#8B1A1A", fontSize: 13, margin: 0 }}>{error}</p>}
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 4 }}>Full name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith"
                style={{ width: "100%", height: 40, border: "1px solid #ddd", borderRadius: 8, padding: "0 12px", fontSize: 14, boxSizing: "border-box", outline: "none" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 4 }}>Email *</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@apartmentspecialists.co.nz"
                style={{ width: "100%", height: 40, border: "1px solid #ddd", borderRadius: 8, padding: "0 12px", fontSize: 14, boxSizing: "border-box", outline: "none" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 4 }}>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as "agent" | "admin")}
                style={{ width: "100%", height: 40, border: "1px solid #ddd", borderRadius: 8, padding: "0 12px", fontSize: 14, background: "white", outline: "none" }}>
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button onClick={handleCreate} disabled={loading}
              style={{ height: 42, borderRadius: 8, background: "#8B1A1A", color: "white", border: "none", fontWeight: 600, fontSize: 14, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
              {loading ? "Creating…" : "Create user"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface EditUserModalProps {
  user: AdminUser;
  currentUserId: string;
  onClose: () => void;
  onUpdated: (user: AdminUser) => void;
}

function EditUserModal({ user, currentUserId, onClose, onUpdated }: EditUserModalProps) {
  const [name, setName] = useState(user.full_name ?? "");
  const [role, setRole] = useState<"agent" | "admin">(user.role as "agent" | "admin");
  const [isActive, setIsActive] = useState(user.is_active);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const isSelf = user.id === currentUserId;

  async function handleSave() {
    setError("");
    setLoading(true);
    try {
      const updated = await updateAdminUser(user.id, {
        full_name: name.trim() || undefined,
        role,
        is_active: isActive,
      });
      onUpdated(updated);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update user.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "white", borderRadius: 12, width: "100%", maxWidth: 420, padding: 24, boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#4A4A4A" }}>Edit user</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#aaa", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {error && <p style={{ background: "#FEE", borderRadius: 6, padding: "8px 12px", color: "#8B1A1A", fontSize: 13, margin: 0 }}>{error}</p>}
          <p style={{ margin: 0, fontSize: 13, color: "#888" }}>{user.email}</p>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 4 }}>Full name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              style={{ width: "100%", height: 40, border: "1px solid #ddd", borderRadius: 8, padding: "0 12px", fontSize: 14, boxSizing: "border-box", outline: "none" }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 4 }}>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as "agent" | "admin")} disabled={isSelf}
              style={{ width: "100%", height: 40, border: "1px solid #ddd", borderRadius: 8, padding: "0 12px", fontSize: 14, background: "white", outline: "none", opacity: isSelf ? 0.5 : 1 }}>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {!isSelf && (
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} style={{ width: 16, height: 16 }} />
              <span style={{ fontSize: 13, color: "#4A4A4A" }}>Active account</span>
            </label>
          )}
          {isSelf && (
            <p style={{ margin: 0, fontSize: 12, color: "#aaa" }}>You cannot change your own role or deactivate yourself.</p>
          )}
          <button onClick={handleSave} disabled={loading}
            style={{ height: 42, borderRadius: 8, background: "#8B1A1A", color: "white", border: "none", fontWeight: 600, fontSize: 14, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const currentUser = getUser() as { id: string; role: string } | null;

  useEffect(() => {
    if (!currentUser || currentUser.role !== "admin") {
      router.replace("/apartments");
      return;
    }
    Promise.all([getAdminStats(), getAdminUsers()])
      .then(([s, u]) => { setStats(s); setUsers(u); })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statCards = stats
    ? [
        { label: "Total apartments", value: stats.total_apartments },
        { label: "Total floor plans", value: stats.total_floor_plans },
        { label: "Active users", value: stats.active_users },
        { label: "This month", value: stats.floor_plans_this_month },
      ]
    : [];

  return (
    <AppShell activePath="/admin">
      {showAddModal && (
        <AddUserModal
          onClose={() => setShowAddModal(false)}
          onCreated={(u) => {
            setUsers((prev) => [u, ...prev]);
            setShowAddModal(false);
          }}
        />
      )}
      {editUser && currentUser && (
        <EditUserModal
          user={editUser}
          currentUserId={currentUser.id}
          onClose={() => setEditUser(null)}
          onUpdated={(updated) => {
            setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
            setEditUser(null);
          }}
        />
      )}

      {/* Header */}
      <div style={{ background: "#fff", borderBottom: "1px solid #eee", padding: "20px 28px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#4A4A4A", margin: 0 }}>Admin dashboard</h1>
      </div>

      <div style={{ padding: "24px 28px", overflowY: "auto" }}>
        {/* Stats row */}
        {stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16, marginBottom: 28 }}>
            {statCards.map((s) => (
              <div key={s.label} style={{ background: "white", borderRadius: 12, border: "1px solid #eee", padding: "18px 20px" }}>
                <p style={{ fontSize: 26, fontWeight: 800, color: "#4A4A4A", margin: "0 0 4px" }}>{s.value}</p>
                <p style={{ fontSize: 12, color: "#aaa", margin: 0 }}>{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Users table */}
        <div style={{ background: "white", borderRadius: 12, border: "1px solid #eee", overflow: "hidden" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#4A4A4A" }}>
              Users
              <span style={{ marginLeft: 8, background: "#f0f0f0", color: "#666", fontSize: 11, borderRadius: 10, padding: "2px 8px" }}>
                {users.length}
              </span>
            </h3>
            <button
              onClick={() => setShowAddModal(true)}
              style={{ background: "#8B1A1A", color: "white", border: "none", borderRadius: 7, padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
            >
              + Add user
            </button>
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: "#aaa" }}>Loading…</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#fafafa" }}>
                    {["Name", "Email", "Role", "Status", "Last login", ""].map((h) => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: "#999", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ borderTop: "1px solid #f5f5f5" }}>
                      <td style={{ padding: "12px 14px", fontWeight: 500, color: "#4A4A4A" }}>
                        {u.full_name ?? <span style={{ color: "#ccc" }}>—</span>}
                      </td>
                      <td style={{ padding: "12px 14px", color: "#666" }}>{u.email}</td>
                      <td style={{ padding: "12px 14px" }}>
                        <span style={{
                          fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 600,
                          background: u.role === "admin" ? "#FFEBEE" : "#E3F2FD",
                          color: u.role === "admin" ? "#C62828" : "#1565C0",
                        }}>
                          {u.role === "admin" ? "Admin" : "Agent"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", background: u.is_active ? "#4CAF50" : "#ccc", display: "inline-block" }} />
                          {u.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td style={{ padding: "12px 14px", color: "#888" }}>{formatDate(u.last_login)}</td>
                      <td style={{ padding: "12px 14px" }}>
                        <button
                          onClick={() => setEditUser(u)}
                          style={{ background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "4px 10px", fontSize: 12, color: "#4A4A4A", cursor: "pointer" }}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
