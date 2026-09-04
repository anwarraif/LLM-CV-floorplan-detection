"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "@/lib/auth";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    if (isLoggedIn()) {
      router.replace("/upload");
    } else {
      router.replace("/login");
    }
  }, [router]);

  return (
    <div className="app-shell items-center justify-center">
      <div className="w-8 h-8 border-2 border-[#8B1A1A] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
