"use client";

import { useEffect, useRef, useState } from "react";

const MAX_WAIT_MS = 2500;

export function LogoLoadingOverlay() {
  const [visible, setVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleHide = () => {
      hideTimer.current = setTimeout(() => setVisible(false), 0);
    };

    const onReady = () => {
      scheduleHide();
    };

    const forceHideTimer = setTimeout(() => {
      scheduleHide();
    }, MAX_WAIT_MS);

    if (
      typeof document !== "undefined" &&
      (document.readyState === "interactive" || document.readyState === "complete")
    ) {
      onReady();
    } else {
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
    }

    return () => {
      document.removeEventListener("DOMContentLoaded", onReady);
      clearTimeout(forceHideTimer);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-120 flex items-center justify-center bg-background">
      <div className="relative h-44 w-60 overflow-hidden">
        <div className="absolute left-1/2 top-2.5 -translate-x-1/2">
          <img
            src="/codex-app.webp"
            alt="Codex logo"
            width={90}
            height={90}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            draggable={false}
            className="block select-none"
          />
        </div>
        <div
          className="absolute left-1/2 top-34.5 h-1.5 w-55 -translate-x-1/2 overflow-hidden rounded-full"
          style={{
            background: "color-mix(in oklab, var(--muted) 88%, white 12%)",
          }}
          aria-hidden
        >
          <div
            className="pointer-events-none absolute left-0 top-0 h-full w-19.5 rounded-full"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, #7ea2ff 14%, #a8b8ff 32%, #a78bfa 52%, #6e7cff 72%, #4c63ff 86%, transparent 100%)",
              transform: "translateX(-110%)",
              animation: "logo-loader-flow 5.6s linear infinite",
            }}
          />
        </div>
      </div>
      <style>{`
        @keyframes logo-loader-flow {
          0% { transform: translateX(-110%); }
          14% { transform: translateX(-110%); }
          48% { transform: translateX(320%); }
          58% { transform: translateX(320%); }
          92% { transform: translateX(-110%); }
          100% { transform: translateX(-110%); }
        }
      `}</style>
    </div>
  );
}
