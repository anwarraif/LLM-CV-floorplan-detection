"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import ProgressBar from "@/components/ProgressBar";

interface SaveResult {
  apartment_id: string;
  apartment_name: string;
  total_internal_m2: number;
  total_balcony_m2: number;
  total_m2: number;
  rooms: Array<{ id: string }>;
  version: number;
}

export default function SuccessPage() {
  const router = useRouter();
  const [result, setResult] = useState<SaveResult | null>(null);
  const [countdown, setCountdown] = useState(3);

  useEffect(() => {
    const raw = sessionStorage.getItem("save_result");
    if (!raw) { router.replace("/upload"); return; }
    try {
      setResult(JSON.parse(raw));
    } catch {
      router.replace("/upload");
    }
  }, [router]);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => { router.push(`/apartments/${result.apartment_id}`); }, 3000);
    const tick = setInterval(() => { setCountdown((c) => Math.max(0, c - 1)); }, 1000);
    return () => { clearTimeout(timer); clearInterval(tick); };
  }, [result, router]);

  function handleUploadAnother() {
    sessionStorage.removeItem("upload_result");
    sessionStorage.removeItem("specified_rooms");
    sessionStorage.removeItem("review_result");
    sessionStorage.removeItem("measure_result");
    sessionStorage.removeItem("save_result");
    router.push("/upload");
  }

  if (!result) return null;

  return (
    <div className="app-shell">
      <TopBar />
      <ProgressBar currentStep={6} totalSteps={6} />

      <div className="flex-1 px-4 py-8 flex flex-col items-center gap-6">
        {/* Success icon */}
        <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <div className="text-center">
          <h1 className="text-[#4A4A4A] text-2xl font-bold">Saved successfully</h1>
          <p className="text-gray-500 text-sm mt-1 font-medium">{result.apartment_name}</p>
          <p className="text-gray-400 text-xs mt-0.5">Version {result.version}</p>
        </div>

        {/* Stat cards */}
        <div className="w-full grid grid-cols-2 gap-3">
          <div className="bg-[#F5E8E8] rounded-xl px-4 py-4 text-center">
            <p className="text-[#8B1A1A] text-2xl font-black">{result.total_internal_m2}</p>
            <p className="text-[#8B1A1A] text-xs mt-0.5">Internal m²</p>
          </div>
          <div className="bg-orange-50 rounded-xl px-4 py-4 text-center">
            <p className="text-orange-600 text-2xl font-black">{result.total_balcony_m2}</p>
            <p className="text-orange-600 text-xs mt-0.5">Balcony m²</p>
          </div>
          <div className="bg-gray-50 rounded-xl px-4 py-4 text-center">
            <p className="text-[#4A4A4A] text-2xl font-black">{result.rooms?.length || 0}</p>
            <p className="text-gray-500 text-xs mt-0.5">Rooms</p>
          </div>
          <div className="bg-gray-50 rounded-xl px-4 py-4 text-center">
            <p className="text-[#4A4A4A] text-2xl font-black">{result.total_m2}</p>
            <p className="text-gray-500 text-xs mt-0.5">Total m²</p>
          </div>
        </div>

        {/* Buttons */}
        <div className="w-full flex flex-col gap-3 mt-auto">
          <button
            onClick={() => router.push(`/apartments/${result.apartment_id}`)}
            className="w-full h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold active:bg-[#6B1414] transition-colors"
          >
            View floor plan
          </button>
          <button
            onClick={() => router.push("/apartments")}
            className="w-full h-12 rounded-xl border-2 border-[#8B1A1A] text-[#8B1A1A] font-medium active:bg-[#F5E8E8] transition-colors"
          >
            Back to apartments
          </button>
          <button
            onClick={handleUploadAnother}
            className="w-full h-12 rounded-xl border-2 border-gray-200 text-gray-600 font-medium active:bg-gray-50 transition-colors"
          >
            Upload another floor plan
          </button>
          <p className="text-center text-xs text-gray-400">
            Redirecting in {countdown}s...
          </p>
        </div>
      </div>
    </div>
  );
}
