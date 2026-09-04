"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import { getUser, removeToken } from "@/lib/auth";
import { getApartments, type ApartmentListItem } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

function buildImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = API_URL.replace(/\/$/, "");
  const path = url.startsWith("/") ? url : "/" + url;
  return base + path;
}

interface AppShellProps {
  children: React.ReactNode;
  activePath?: string;
}

// ---- Icons ----
function IconGrid() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  );
}
function IconLogout() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  );
}
function IconMenu() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  );
}
function IconFloorPlan() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18M9 21V9"/>
    </svg>
  );
}

export default function AppShell({ children, activePath }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [user, setUser] = useState<{ id: string; email: string; full_name: string | null; role: string } | null>(null);
  const [recentApartments, setRecentApartments] = useState<ApartmentListItem[]>([]);

  const active = activePath || pathname;

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const u = getUser();
    if (u) setUser(u as typeof user);
    getApartments()
      .then((data) => setRecentApartments(data.slice(0, 5)))
      .catch(() => {});
  }, []);

  function handleLogout() {
    removeToken();
    router.replace("/login");
  }

  const isAdmin = user?.role === "admin";

  const initials = user?.full_name
    ? user.full_name.split(" ").map((p) => p[0]).join("").toUpperCase().slice(0, 2)
    : (user?.email?.slice(0, 2).toUpperCase() ?? "??");

  const navItems = [
    {
      href: "/apartments",
      label: "My floor plans",
      isActive: active.startsWith("/apartments"),
      icon: <IconGrid />,
    },
    ...(isAdmin
      ? [
          {
            href: "/admin",
            label: "User management",
            isActive: active === "/admin",
            icon: <IconUsers />,
          },
          {
            href: "/reports",
            label: "Reports",
            isActive: active === "/reports",
            icon: <IconChart />,
          },
        ]
      : []),
  ];

  const sidebar = (
    <div
      style={{
        width: 260,
        background: "#4A4A4A",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div style={{ padding: "20px 16px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <Logo size="md" showText layout="row" />
      </div>

      {/* New floor plan button */}
      <div style={{ padding: "14px 16px 8px" }}>
        <Link
          href="/upload"
          onClick={() => setSidebarOpen(false)}
          style={{
            display: "block",
            textAlign: "center",
            background: "#8B1A1A",
            color: "white",
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 14,
            textDecoration: "none",
            padding: "10px 0",
          }}
        >
          + New floor plan
        </Link>
      </div>

      {/* Navigation */}
      <nav style={{ padding: "4px 8px" }}>
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setSidebarOpen(false)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 8,
              color: item.isActive ? "#ffffff" : "rgba(255,255,255,0.65)",
              background: item.isActive ? "rgba(255,255,255,0.12)" : "transparent",
              fontWeight: item.isActive ? 600 : 400,
              fontSize: 14,
              textDecoration: "none",
            }}
          >
            {item.icon}
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Divider */}
      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "8px 16px" }} />

      {/* Recent apartments */}
      <div style={{ padding: "4px 16px 8px", flex: 1 }}>
        <p
          style={{
            color: "rgba(255,255,255,0.45)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Recent
        </p>

        {recentApartments.length === 0 ? (
          <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No floor plans yet</p>
        ) : (
          recentApartments.map((apt) => (
            <Link
              key={apt.apartment_id}
              href={`/apartments/${apt.apartment_id}`}
              onClick={() => setSidebarOpen(false)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px", textDecoration: "none" }}
            >
              {/* Thumbnail */}
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 4,
                  overflow: "hidden",
                  background: "rgba(255,255,255,0.08)",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {apt.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={buildImageUrl(apt.thumbnail_url)}
                    alt={apt.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <IconFloorPlan />
                )}
              </div>

              {/* Name + meta */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    color: "rgba(255,255,255,0.85)",
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    margin: 0,
                  }}
                >
                  {apt.name}
                </p>
                <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, margin: 0 }}>
                  {apt.total_internal_m2 ? `${apt.total_internal_m2} m²` : "—"}
                  {apt.latest_version ? ` · v${apt.latest_version}` : ""}
                </p>
              </div>
            </Link>
          ))
        )}

        <Link
          href="/apartments"
          onClick={() => setSidebarOpen(false)}
          style={{ display: "block", marginTop: 6, color: "rgba(255,255,255,0.4)", fontSize: 12, textDecoration: "none" }}
        >
          View all →
        </Link>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 16px" }} />

      {/* User row */}
      <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "#8B1A1A",
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              color: "rgba(255,255,255,0.9)",
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              margin: 0,
            }}
          >
            {user?.full_name || user?.email || "User"}
          </p>
          <p
            style={{
              fontSize: 11,
              margin: 0,
              color: isAdmin ? "#E57373" : "rgba(255,255,255,0.45)",
              fontWeight: isAdmin ? 600 : 400,
            }}
          >
            {isAdmin ? "Admin" : "Agent"}
          </p>
        </div>
        <button
          onClick={handleLogout}
          style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.5)", padding: 4 }}
          title="Sign out"
        >
          <IconLogout />
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#F5F5F5" }}>
      {/* Desktop sidebar */}
      {!isMobile && sidebar}

      {/* Mobile overlay backdrop */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.5)" }}
        />
      )}

      {/* Mobile slide-in sidebar */}
      {isMobile && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            bottom: 0,
            zIndex: 50,
            width: 260,
            transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
            transition: "transform 0.25s ease",
          }}
        >
          {sidebar}
        </div>
      )}

      {/* Main content */}
      <div id="main-scroll-area" data-scroll-container="true" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Mobile top bar */}
        {isMobile && (
          <div
            style={{
              background: "#4A4A4A",
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => setSidebarOpen(true)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "white", padding: 4 }}
            >
              <IconMenu />
            </button>
            <Logo size="sm" showText layout="row" />
          </div>
        )}

        {children}
      </div>
    </div>
  );
}
