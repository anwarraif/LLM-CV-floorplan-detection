"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { forgotPassword, verifyOtp, resetPassword } from "@/lib/api";

type Step = 1 | 2 | 3 | 4;

function PasswordStrength({ password }: { password: string }) {
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  const colors = ["bg-red-400", "bg-orange-400", "bg-yellow-400", "bg-green-500"];
  const labels = ["Weak", "Fair", "Good", "Strong"];

  if (!password) return null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${i < score ? colors[score - 1] : "bg-gray-200"}`}
          />
        ))}
      </div>
      <span className={`text-xs ${score < 2 ? "text-red-500" : score < 3 ? "text-yellow-600" : "text-green-600"}`}>
        {labels[score - 1] || "Too short"}
      </span>
    </div>
  );
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(60);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (step !== 2) return;
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(timer); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [step]);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email) { setError("Please enter your email."); return; }
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setStep(2);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send code.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const code = otp.join("");
    if (code.length < 6) { setError("Please enter all 6 digits."); return; }
    setLoading(true);
    try {
      await verifyOtp(email.trim(), code);
      setStep(3);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Invalid or expired code.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      await resetPassword(email.trim(), otp.join(""), newPassword);
      setStep(4);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reset password.");
    } finally {
      setLoading(false);
    }
  }

  function handleOtpInput(index: number, value: string) {
    const digit = value.replace(/\D/g, "").slice(-1);
    const next = [...otp];
    next[index] = digit;
    setOtp(next);
    if (digit && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  }

  async function handleResend() {
    setError("");
    setOtp(["", "", "", "", "", ""]);
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setCountdown(60);
    } catch {
      setError("Failed to resend code.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      {/* Header */}
      <div className="bg-[#4A4A4A] px-4 py-3 flex items-center gap-3">
        <Link href="/login" className="text-white p-1 rounded-lg active:bg-white/10">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M15 18L9 12L15 6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="text-white font-semibold text-sm">Forgot Password</span>
      </div>

      <div className="flex-1 px-6 py-8 flex flex-col gap-6">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-[#8B1A1A]">
            {error}
          </div>
        )}

        {/* Step 1 */}
        {step === 1 && (
          <form onSubmit={handleSendOtp} className="flex flex-col gap-6">
            <div>
              <h2 className="text-[#4A4A4A] text-xl font-semibold">Forgot password?</h2>
              <p className="text-gray-500 text-sm mt-1">Enter your email and we&apos;ll send a verification code.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[#4A4A4A]">Email</label>
              <input
                type="email"
                placeholder="you@apartmentspecialists.co.nz"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-12 border border-gray-200 rounded-xl px-4 text-base text-gray-800 focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Sending...</> : "Send verification code"}
            </button>
          </form>
        )}

        {/* Step 2 */}
        {step === 2 && (
          <form onSubmit={handleVerifyOtp} className="flex flex-col gap-6">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-[#F5E8E8] flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8B1A1A" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
              </div>
              <div className="text-center">
                <h2 className="text-[#4A4A4A] text-xl font-semibold">Check your email</h2>
                <p className="text-gray-500 text-sm mt-1">We sent a 6-digit code to<br /><span className="font-medium text-gray-700">{email}</span></p>
              </div>
            </div>

            <div className="flex justify-center gap-2">
              {otp.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { otpRefs.current[i] = el; }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleOtpInput(i, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(i, e)}
                  className="w-11 h-14 border-2 border-gray-200 rounded-xl text-center text-xl font-bold text-[#4A4A4A] focus:outline-none focus:border-[#8B1A1A] transition"
                />
              ))}
            </div>

            <button
              type="submit"
              disabled={loading || otp.join("").length < 6}
              className="h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Verifying...</> : "Verify code"}
            </button>

            <button
              type="button"
              onClick={handleResend}
              disabled={countdown > 0 || loading}
              className="text-sm text-center text-[#8B1A1A] disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              {countdown > 0 ? `Resend code (${countdown}s)` : "Resend code"}
            </button>
          </form>
        )}

        {/* Step 3 */}
        {step === 3 && (
          <form onSubmit={handleResetPassword} className="flex flex-col gap-6">
            <div>
              <h2 className="text-[#4A4A4A] text-xl font-semibold">Set new password</h2>
              <p className="text-gray-500 text-sm mt-1">Choose a strong password.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[#4A4A4A]">New password</label>
              <input
                type="password"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="h-12 border border-gray-200 rounded-xl px-4 text-base text-gray-800 focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
              />
              <PasswordStrength password={newPassword} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[#4A4A4A]">Confirm password</label>
              <input
                type="password"
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-12 border border-gray-200 rounded-xl px-4 text-base text-gray-800 focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</> : "Set new password"}
            </button>
          </form>
        )}

        {/* Step 4 */}
        {step === 4 && (
          <div className="flex flex-col items-center gap-6 py-8">
            <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-[#4A4A4A] text-xl font-semibold">Password updated!</h2>
              <p className="text-gray-500 text-sm mt-1">You can now sign in with your new password.</p>
            </div>
            <button
              onClick={() => router.replace("/login")}
              className="w-full h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold"
            >
              Back to login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
