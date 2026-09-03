import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import codexShellLogoUrl from "@/assets/codex-shell-logo.svg";

export const AUTH_INPUT_CLASS_NAME =
  "h-12 w-full rounded-lg border bg-background/60 px-4 text-base outline-none transition-colors focus:border-foreground/40";

function AuthBackground() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "rgb(239, 238, 254)" }}
      />
      <video
        className="absolute inset-0 h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        poster="/floral_a.webp"
      >
        <source
          src="https://cdn.openai.com/ctf-cdn/floral_a.mp4"
          type="video/mp4"
        />
      </video>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(239,238,254,0.04)_0%,rgba(239,238,254,0.02)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_32%,rgba(255,255,255,0.06)_0%,rgba(255,255,255,0)_54%)]" />
    </div>
  );
}

function Corner({
  className,
  rotate = "",
}: {
  className: string;
  rotate?: string;
}) {
  return (
    <span
      aria-hidden
      className={`absolute scale-[0.72] text-foreground/85 opacity-0 transition-all duration-200 ease-out group-hover:scale-100 group-hover:opacity-100 ${className}`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        className={rotate}
      >
        <path
          d="M17 1H8C4.134 1 1 4.134 1 8V17"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function AuthPage({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <main
      className="relative min-h-dvh overflow-hidden px-6 text-foreground select-none"
      style={{ backgroundColor: "rgb(239, 238, 254)" }}
    >
      <AuthBackground />
      <section className="relative mx-auto flex min-h-dvh w-full max-w-140 flex-col items-center justify-center gap-6">
        <div className="flex items-center gap-2 text-lg font-medium">
          <img
            src={codexShellLogoUrl}
            alt="CoCodex"
            width={22}
            height={22}
            className="rounded-sm"
          />
          <span>CoCodex</span>
        </div>
        <p className="text-center text-base">{heading}</p>
        {children}
      </section>
    </main>
  );
}

export function AuthSubmitButton({
  submitting,
  disabled,
  idleLabel,
  submittingLabel,
}: {
  submitting: boolean;
  disabled?: boolean;
  idleLabel: string;
  submittingLabel: string;
}) {
  return (
    <div className="group relative mt-3">
      <div className="pointer-events-none absolute inset-0">
        <Corner className="top-0 left-0 group-hover:-translate-x-2.5 group-hover:-translate-y-2.5" />
        <Corner
          className="top-0 right-0 group-hover:translate-x-2.5 group-hover:-translate-y-2.5"
          rotate="rotate-90"
        />
        <Corner
          className="bottom-0 left-0 group-hover:-translate-x-2.5 group-hover:translate-y-2.5"
          rotate="-rotate-90"
        />
        <Corner
          className="right-0 bottom-0 group-hover:translate-x-2.5 group-hover:translate-y-2.5"
          rotate="rotate-180"
        />
      </div>
      <button
        type="submit"
        disabled={disabled || submitting}
        className="relative z-1 inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-base font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {submitting ? submittingLabel : idleLabel}
      </button>
    </div>
  );
}
