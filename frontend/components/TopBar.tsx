import Logo from "./Logo";

interface TopBarProps {
  showBack?: boolean;
  onBack?: () => void;
  title?: string;
}

export default function TopBar({ showBack = false, onBack, title }: TopBarProps) {
  return (
    <div
      className="app-header"
      style={{
        padding: "12px 16px",
        paddingTop: "calc(12px + env(safe-area-inset-top, 0px))",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        minHeight: "56px",
      }}
    >
      {showBack ? (
        <button
          onClick={onBack}
          className="text-white rounded-lg active:bg-white/10 transition-colors flex-shrink-0"
          style={{
            width: "36px",
            height: "36px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            background: "none",
            border: "none",
            padding: 0,
            margin: 0,
          }}
          aria-label="Go back"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ display: "block" }}>
            <path d="M15 18L9 12L15 6" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}

      {!showBack && <Logo size="md" showText layout="row" />}

      {!showBack ? null : (
        <div className="flex flex-col leading-tight flex-1">
          {title ? (
            <span className="font-semibold text-white text-sm">{title}</span>
          ) : (
            <>
              <span className="font-bold text-white text-sm tracking-tight">Apartment Specialists</span>
              <span className="text-gray-300 text-xs">Floor Plan Tool</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
