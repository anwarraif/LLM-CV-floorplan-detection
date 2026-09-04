"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/TopBar";
import ProgressBar from "@/components/ProgressBar";
import FloorPlanViewer from "@/components/FloorPlanViewer";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";

type RoomCounts = Record<string, number>;

const ROOM_CONFIG: Array<{
  key: string;
  label: string;
  defaultCount: number;
  max: number;
  exterior: boolean;
  isBalcony: boolean;
}> = [
  { key: "bedrooms",    label: "Bedrooms",                defaultCount: 1, max: 10, exterior: false, isBalcony: false },
  { key: "bathrooms",   label: "Bathrooms / Toilets",     defaultCount: 1, max: 5,  exterior: false, isBalcony: false },
  { key: "living_room", label: "Living Room",             defaultCount: 1, max: 3,  exterior: false, isBalcony: false },
  { key: "kitchen",     label: "Kitchen",                 defaultCount: 1, max: 2,  exterior: false, isBalcony: false },
  { key: "dining_area", label: "Dining Area",             defaultCount: 0, max: 2,  exterior: false, isBalcony: false },
  { key: "study",       label: "Study / Flexi Room",      defaultCount: 0, max: 3,  exterior: false, isBalcony: false },
  { key: "balcony",     label: "Balcony",                 defaultCount: 0, max: 4,  exterior: true,  isBalcony: true  },
  { key: "deck",        label: "Deck / Terrace",          defaultCount: 0, max: 2,  exterior: true,  isBalcony: true  },
  { key: "laundry",     label: "Laundry",                 defaultCount: 0, max: 2,  exterior: false, isBalcony: false },
  { key: "ensuite",     label: "Ensuite",                 defaultCount: 0, max: 4,  exterior: false, isBalcony: false },
  { key: "wardrobe",    label: "Walk-in Wardrobe / Robe", defaultCount: 0, max: 4,  exterior: false, isBalcony: false },
  { key: "storage",     label: "Storage Room",            defaultCount: 0, max: 4,  exterior: false, isBalcony: false },
  { key: "entry",       label: "Entry / Foyer",           defaultCount: 0, max: 2,  exterior: false, isBalcony: false },
  { key: "garage",      label: "Internal Garage",         defaultCount: 0, max: 4,  exterior: false, isBalcony: false },
];

function buildDefaultCounts(): RoomCounts {
  return Object.fromEntries(ROOM_CONFIG.map((r) => [r.key, r.defaultCount]));
}

function isBalconyRoom(name: string) {
  return /balcony|deck|terrace/i.test(name);
}

interface QuantityProps {
  count: number;
  max: number;
  onDecrease: () => void;
  onIncrease: () => void;
}

function QuantitySelector({ count, max, onDecrease, onIncrease }: QuantityProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <button
        onClick={onDecrease}
        disabled={count === 0}
        style={{
          width: 36, height: 36, borderRadius: "50%",
          border: "1.5px solid #ccc",
          background: count === 0 ? "#f5f5f5" : "#fff",
          fontSize: "18px", cursor: count === 0 ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: count === 0 ? "#ccc" : "#333",
          flexShrink: 0,
        }}
      >
        −
      </button>
      <span style={{
        minWidth: "24px", textAlign: "center",
        fontSize: "16px", fontWeight: 500,
        color: count === 0 ? "#ccc" : "#333",
      }}>
        {count}
      </span>
      <button
        onClick={onIncrease}
        disabled={count >= max}
        style={{
          width: 36, height: 36, borderRadius: "50%",
          border: count >= max ? "1.5px solid #ccc" : "1.5px solid #8B1A1A",
          background: "#fff", fontSize: "18px",
          cursor: count >= max ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: count >= max ? "#ccc" : "#8B1A1A",
          flexShrink: 0,
        }}
      >
        +
      </button>
    </div>
  );
}

export default function SpecifyPage() {
  const router = useRouter();
  const [roomCounts, setRoomCounts] = useState<RoomCounts>(buildDefaultCounts);
  const [customRooms, setCustomRooms] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [apartmentName, setApartmentName] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const raw = sessionStorage.getItem("upload_result");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      setImageUrl(data.image_url || null);
      setApartmentName(data.apartment_name || null);
    } catch { /* ignore */ }

    return () => {
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, []);

  function increase(key: string) {
    const cfg = ROOM_CONFIG.find((r) => r.key === key);
    const max = cfg?.max ?? 10;
    setRoomCounts((prev) => ({ ...prev, [key]: Math.min(max, (prev[key] ?? 0) + 1) }));
  }

  function decrease(key: string) {
    setRoomCounts((prev) => ({ ...prev, [key]: Math.max(0, (prev[key] ?? 0) - 1) }));
  }

  const totalRooms = Object.values(roomCounts).reduce((sum, c) => sum + c, 0)
    + (customRooms.trim() ? customRooms.split(",").filter((s) => s.trim()).length : 0);

  function handleContinue() {
    const rooms: Array<{ room_name: string; is_balcony: boolean }> = [];

    const n = (key: string) => roomCounts[key] ?? 0;

    for (let i = 1; i <= n("bedrooms"); i++)
      rooms.push({ room_name: n("bedrooms") > 1 ? `Bedroom ${i}` : "Bedroom", is_balcony: false });

    for (let i = 1; i <= n("bathrooms"); i++)
      rooms.push({ room_name: n("bathrooms") > 1 ? `Bathroom ${i}` : "Bathroom", is_balcony: false });

    for (let i = 1; i <= n("living_room"); i++)
      rooms.push({ room_name: n("living_room") > 1 ? `Living Room ${i}` : "Living Room", is_balcony: false });

    for (let i = 1; i <= n("kitchen"); i++)
      rooms.push({ room_name: n("kitchen") > 1 ? `Kitchen ${i}` : "Kitchen", is_balcony: false });

    for (let i = 1; i <= n("dining_area"); i++)
      rooms.push({ room_name: n("dining_area") > 1 ? `Dining Area ${i}` : "Dining Area", is_balcony: false });

    for (let i = 1; i <= n("study"); i++)
      rooms.push({ room_name: n("study") > 1 ? `Study ${i}` : "Study", is_balcony: false });

    for (let i = 1; i <= n("balcony"); i++)
      rooms.push({ room_name: n("balcony") > 1 ? `Balcony ${i}` : "Balcony", is_balcony: true });

    for (let i = 1; i <= n("deck"); i++)
      rooms.push({ room_name: n("deck") > 1 ? `Deck ${i}` : "Deck", is_balcony: true });

    for (let i = 1; i <= n("laundry"); i++)
      rooms.push({ room_name: "Laundry", is_balcony: false });

    for (let i = 1; i <= n("ensuite"); i++)
      rooms.push({ room_name: n("ensuite") > 1 ? `Ensuite ${i}` : "Ensuite", is_balcony: false });

    for (let i = 1; i <= n("wardrobe"); i++)
      rooms.push({ room_name: n("wardrobe") > 1 ? `Wardrobe ${i}` : "Walk-in Wardrobe", is_balcony: false });

    for (let i = 1; i <= n("storage"); i++)
      rooms.push({ room_name: n("storage") > 1 ? `Storage ${i}` : "Storage Room", is_balcony: false });

    for (let i = 1; i <= n("entry"); i++)
      rooms.push({ room_name: "Entry / Foyer", is_balcony: false });

    for (let i = 1; i <= n("garage"); i++)
      rooms.push({ room_name: "Internal Garage", is_balcony: false });

    if (customRooms.trim()) {
      customRooms.split(",").forEach((entry) => {
        const name = entry.trim();
        if (name) rooms.push({ room_name: name, is_balcony: isBalconyRoom(name) });
      });
    }

    sessionStorage.removeItem("review_completed");
    sessionStorage.removeItem("review_result");
    sessionStorage.removeItem("came_from_measure");
    sessionStorage.setItem("specified_rooms", JSON.stringify(rooms));
    router.push("/review");
  }

  return (
    <div className="app-shell" style={{ height: "100dvh", maxHeight: "100dvh", overflow: "hidden" }}>
      <FloorPlanViewer
        isOpen={viewerOpen}
        onClose={() => setViewerOpen(false)}
        imageUrl={imageUrl ?? ""}
        rooms={[]}
      />
      <TopBar showBack onBack={() => router.back()} />
      <ProgressBar currentStep={2} totalSteps={6} />

      {/* Title & Floor plan preview - Fixed at the top */}
      <div className="flex-shrink-0 px-4 pt-5 pb-3 flex flex-col gap-4 border-b border-gray-100">
        <div>
          <h2 className="text-[#4A4A4A] text-xl font-bold">What rooms does this apartment have?</h2>
          <p className="text-gray-500 text-sm mt-1">Set the quantity of each room type.</p>
        </div>

        {imageUrl && (
          <div>
            <div style={{
              width: "100%", maxHeight: "160px", background: "#f5f5f5",
              borderRadius: "8px", overflow: "hidden",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${API_URL}${imageUrl}`}
                alt="Floor plan"
                style={{ width: "100%", maxHeight: "160px", objectFit: "contain", display: "block" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "6px" }}>
              {apartmentName && (
                <span style={{ fontSize: "12px", color: "#6B7280", fontStyle: "italic" }}>
                  {apartmentName}
                </span>
              )}
              <button
                onClick={() => setViewerOpen(true)}
                style={{
                  background: "none", border: "none", cursor: "pointer", padding: 0,
                  fontSize: "12px", color: "#8B1A1A", fontWeight: 500,
                  textDecoration: "underline", textUnderlineOffset: "2px",
                  marginLeft: "auto",
                }}
              >
                View full size
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Scrollable Room quantity selectors */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          {ROOM_CONFIG.map((cfg) => {
            const count = roomCounts[cfg.key] ?? 0;
            return (
              <div
                key={cfg.key}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 16px", borderRadius: "10px",
                  border: count > 0 ? "1px solid #ddd" : "1px solid #f0f0f0",
                  background: count > 0 ? "#fff" : "#fafafa",
                  opacity: count === 0 ? 0.55 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{
                    fontSize: "14px",
                    fontWeight: count > 0 ? 500 : 400,
                    color: count > 0 ? "#333" : "#bbb",
                  }}>
                    {cfg.label}
                  </span>
                  {cfg.exterior && (
                    <span style={{
                      fontSize: "11px", color: "#854F0B",
                      background: "#FAEEDA", padding: "2px 7px", borderRadius: "20px",
                    }}>
                      exterior
                    </span>
                  )}
                </div>
                <QuantitySelector
                  count={count}
                  max={cfg.max}
                  onDecrease={() => decrease(cfg.key)}
                  onIncrease={() => increase(cfg.key)}
                />
              </div>
            );
          })}
        </div>

        {/* Custom rooms */}
        <div>
          <label className="text-sm font-semibold text-[#4A4A4A] mb-2 block">
            Any other rooms? <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            type="text"
            value={customRooms}
            onChange={(e) => setCustomRooms(e.target.value)}
            placeholder="e.g. Sunroom, Office, Wine Cellar"
            className="w-full h-12 border border-gray-200 rounded-xl px-4 text-sm text-gray-800 focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A] transition"
          />
          <p className="text-xs text-gray-400 mt-1.5">Separate multiple rooms with commas</p>
        </div>

        <div className="pb-4">
          <div style={{ fontSize: "13px", color: "#6B7280", textAlign: "center", marginBottom: "8px" }}>
            {totalRooms === 0 ? "No rooms selected" : `${totalRooms} room${totalRooms === 1 ? "" : "s"} selected`}
          </div>
          <button
            onClick={handleContinue}
            disabled={totalRooms === 0}
            className="w-full h-12 rounded-xl bg-[#8B1A1A] text-white font-semibold disabled:opacity-40 active:bg-[#6B1414] transition-colors"
          >
            Continue — locate rooms
          </button>
        </div>
      </div>
    </div>
  );
}
