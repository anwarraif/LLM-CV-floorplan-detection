import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Floor Plan Tool – Apartment Specialists",
  description: "Mobile floor plan measurement tool",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full" style={{ backgroundColor: "#4A4A4A" }}>{children}</body>
    </html>
  );
}
