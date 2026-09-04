export function saveToken(token: string) {
  if (typeof window !== "undefined") {
    // Set a cookie (this is needed for middleware proxy.ts)
    document.cookie = `apt_token=${token}; path=/; max-age=${30 * 24 * 60 * 60}; SameSite=Lax`;
  }
}

export function removeToken() {
  if (typeof window !== "undefined") {
    // Clear cookie
    document.cookie = "apt_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    localStorage.removeItem("apt_user");
  }
}

export function saveUser(user: { id: string; email: string; full_name: string | null; role: string }) {
  if (typeof window !== "undefined") {
    localStorage.setItem("apt_user", JSON.stringify(user));
  }
}

export function getUser(): { id: string; email: string; full_name: string | null; role: string } | null {
  if (typeof window !== "undefined") {
    const raw = localStorage.getItem("apt_user");
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function isLoggedIn(): boolean {
  if (typeof window !== "undefined") {
    // Check if the cookie exists
    return document.cookie.split(";").some((c) => c.trim().startsWith("apt_token="));
  }
  return false;
}

export function getToken(): string | null {
  if (typeof window !== "undefined") {
    const matches = document.cookie.match(/(^| )apt_token=([^;]+)/);
    if (matches) {
      return matches[2];
    }
  }
  return null;
}
