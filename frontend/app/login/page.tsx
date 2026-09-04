"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import { login } from "@/lib/api";
import { saveToken, saveUser } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      const data = await login(email.trim(), password);
      saveToken(data.access_token);
      saveUser({ id: data.user_id, email: data.email, full_name: data.full_name, role: data.role });
      router.replace("/apartments");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      {/* Header */}
      <div className="app-header" style={{ padding: "40px 16px 28px", textAlign: "center" }}>
        <Logo size="lg" showText={true} layout="column" />
      </div>

      {/* Form */}
      <div className="flex-1 px-6 py-8 flex flex-col gap-6">
        <h2 className="text-[#4A4A4A] text-xl font-semibold">Sign in</h2>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-[#8B1A1A]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#4A4A4A]">Email</label>
            <input
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="you@apartmentspecialists.co.nz"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-12 border border-gray-200 rounded-xl px-4 text-base text-gray-800 bg-white focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
              disabled={loading}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#4A4A4A]">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-12 w-full border border-gray-200 rounded-xl px-4 pr-12 text-base text-gray-800 bg-white focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 p-1"
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold text-base disabled:opacity-60 active:bg-[#6B1414] transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </button>
        </form>

        <div className="text-center mt-2">
          <Link href="/forgot-password" className="text-sm text-[#8B1A1A] font-medium underline underline-offset-2">
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}
