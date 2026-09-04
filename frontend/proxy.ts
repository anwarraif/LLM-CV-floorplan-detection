import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/forgot-password"];

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip Next.js internals, static files, and API routes
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname === "/favicon.ico" ||
    /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|otf)$/.test(pathname)
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get("apt_token")?.value;

  // Unauthenticated → redirect to login (except public paths)
  if (!token) {
    if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
      return NextResponse.next();
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Authenticated on public paths → redirect to apartments
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.redirect(new URL("/apartments", request.url));
  }

  // Root → apartments
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/apartments", request.url));
  }

  // Admin route protection — non-admin users redirected to /apartments
  if (pathname.startsWith("/admin") || pathname.startsWith("/reports")) {
    const payload = decodeJwtPayload(token);
    if ((payload?.role as string) !== "admin") {
      return NextResponse.redirect(new URL("/apartments", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
