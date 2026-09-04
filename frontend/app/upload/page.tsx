"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import ProgressBar from "@/components/ProgressBar";
import { uploadFloorPlan } from "@/lib/api";

export default function UploadPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // #5: if a floor plan is already in progress (came back to Upload), offer to resume it
  // instead of losing the work / re-uploading. Resume to the furthest safe step.
  const [resumeTo, setResumeTo] = useState<string | null>(null);

  useEffect(() => {
    try {
      if (!sessionStorage.getItem("upload_result")) return;
      // review_result present => they finished Review; jump straight back to Measure.
      const target = sessionStorage.getItem("review_result") ? "/measure" : "/specify";
      setResumeTo(target);
    } catch { /* ignore */ }
  }, []);

  async function processFile(file: File) {
    setError("");
    setSelectedFile(file);
    setLoading(true);
    try {
      const result = await uploadFloorPlan(file);
      // Clear stale flow keys — preserve upload_for_apartment so new version links correctly
      ["review_completed", "review_result", "measurements_draft", "came_from_measure", "specified_rooms", "confirm_data"].forEach(
        (key) => sessionStorage.removeItem(key)
      );
      sessionStorage.setItem("upload_result", JSON.stringify(result));
      router.push("/specify");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      if (msg.toLowerCase().includes("floor plan")) {
        setError("This does not appear to be a floor plan. Please upload a floor plan image.");
      } else {
        setError(msg || "Upload failed. Please try again.");
      }
      setSelectedFile(null);
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }

  return (
    <div className="app-shell">
      <TopBar showBack onBack={() => router.push("/apartments")} />
      <ProgressBar currentStep={1} totalSteps={6} />

      <div className="flex-1 px-4 py-6 flex flex-col gap-6">
        <div>
          <h2 className="text-[#4A4A4A] text-xl font-bold">Upload Floor Plan</h2>
          <p className="text-gray-500 text-sm mt-1">Take a photo or choose a file of the floor plan</p>
        </div>

        {/* #5: resume an in-progress floor plan without re-uploading */}
        {resumeTo && !loading && (
          <button
            onClick={() => router.push(resumeTo)}
            className="w-full text-left rounded-2xl border border-[#8B1A1A]/25 bg-[#F5E8E8] px-4 py-3.5 flex items-center gap-3 active:bg-[#EFD9D9] transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-[#8B1A1A] flex items-center justify-center flex-shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[#8B1A1A]">Continue where you left off</p>
              <p className="text-xs text-[#8B1A1A]/70">You have a floor plan in progress — resume without re-uploading.</p>
            </div>
          </button>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-[#8B1A1A]">
            {error}
          </div>
        )}

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl p-8 flex flex-col items-center gap-3 active:bg-gray-50 transition-colors cursor-pointer"
        >
          {loading && selectedFile ? (
            <>
              <div className="w-10 h-10 border-2 border-[#8B1A1A] border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 text-center">Processing <span className="font-medium text-gray-700">{selectedFile.name}</span>…</p>
              <p className="text-xs text-gray-400">AI is analysing your floor plan</p>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-[#F5E8E8] flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#8B1A1A" strokeWidth="1.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <p className="text-sm font-medium text-[#4A4A4A]">Tap to upload</p>
              <p className="text-xs text-gray-400">or drag and drop here</p>
            </>
          )}
        </div>

        {/* Format pills */}
        <div className="flex gap-2 justify-center">
          {["PDF", "PNG", "JPG"].map((fmt) => (
            <span key={fmt} className="px-3 py-1 bg-gray-100 rounded-full text-xs font-medium text-gray-600">
              {fmt}
            </span>
          ))}
        </div>

        {/* Buttons */}
        <div className="flex flex-col gap-3 mt-auto">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            onClick={() => { const el = document.createElement("input"); el.type="file"; el.accept=".pdf,.png,.jpg,.jpeg"; el.capture="environment"; el.onchange=(e)=>{ const f=(e.target as HTMLInputElement).files?.[0]; if(f) processFile(f); }; el.click(); }}
            disabled={loading}
            className="h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-60 flex items-center justify-center gap-2 active:bg-[#6B1414] transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="4" />
            </svg>
            Take photo
          </button>

          <button
            onClick={() => fileRef.current?.click()}
            disabled={loading}
            className="h-12 rounded-xl border-2 border-[#8B1A1A] text-[#8B1A1A] font-semibold disabled:opacity-60 flex items-center justify-center gap-2 active:bg-[#F5E8E8] transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            Choose from files
          </button>
        </div>
      </div>
    </div>
  );
}
