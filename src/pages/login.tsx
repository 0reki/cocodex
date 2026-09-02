import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import codexShellLogoUrl from "@/assets/codex-shell-logo.svg";
import { InlineNotice } from "@/components/ui";
import { useAuth } from "@/lib/auth";

function safeNextPath(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//")
    ? value
    : "/dashboard";
}

function LoginBackground() {
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

export function LoginPage() {
  const { ready, user, login } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (ready && user) {
    return <Navigate to={safeNextPath(searchParams.get("next"))} replace />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      navigate(safeNextPath(searchParams.get("next")), { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="relative min-h-dvh overflow-hidden px-6 text-foreground select-none"
      style={{ backgroundColor: "rgb(239, 238, 254)" }}
    >
      <LoginBackground />
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
        <p className="text-center text-base">登录以继续使用 CoCodex</p>

        <form
          onSubmit={(event) => void submit(event)}
          className="mt-2 w-full space-y-3"
        >
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
          <label className="block text-sm font-medium" htmlFor="username">
            用户名
          </label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            type="text"
            autoComplete="username"
            autoFocus
            required
            className="h-12 w-full rounded-lg border bg-background/60 px-4 text-base outline-none transition-colors focus:border-foreground/40"
          />
          <label className="block text-sm font-medium" htmlFor="password">
            密码
          </label>
          <input
            id="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            required
            className="h-12 w-full rounded-lg border bg-background/60 px-4 text-base outline-none transition-colors focus:border-foreground/40"
          />
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
              disabled={submitting || !ready}
              className="relative z-1 inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-base font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : null}
              {submitting ? "正在登录" : "登录"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
