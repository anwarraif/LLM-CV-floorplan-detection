type LogoSize = "sm" | "md" | "lg";
type LogoLayout = "row" | "column";

interface LogoProps {
  size?: LogoSize;
  showText?: boolean;
  layout?: LogoLayout;
}

const sizes = { sm: 24, md: 32, lg: 64 };

export default function Logo({ size = "md", showText = false, layout = "row" }: LogoProps) {
  const px = sizes[size];

  if (layout === "column") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/as-logo-header.png"
          alt="Apartment Specialists"
          style={{
            width: px,
            height: px,
            objectFit: "contain",
            display: "block",
            background: "none",
            border: "none",
            padding: 0,
            margin: 0,
          }}
        />
        {showText && (
          <>
            <span style={{ color: "#fff", fontWeight: "bold", fontSize: "18px" }}>
              Apartment Specialists
            </span>
            <span style={{ color: "rgba(255,255,255,0.55)", fontSize: "12px" }}>
              Floor Plan Tool
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/as-logo-header.png"
        alt="Apartment Specialists"
        style={{
          width: px,
          height: px,
          objectFit: "contain",
          display: "block",
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
        }}
      />
      {showText && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ color: "#fff", fontWeight: "500", fontSize: "13px", lineHeight: "1.2" }}>
            Apartment Specialists
          </span>
          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: "10px" }}>
            Floor Plan Tool
          </span>
        </div>
      )}
    </div>
  );
}
