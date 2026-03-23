"use client";

import { useEffect } from "react";
import { useToast } from "@/components/providers/toast-provider";

type AdminLoginFormProps = {
  missingEnv: boolean;
  errorCode: string | null;
  nextPath: string;
  googleEnabled: boolean;
  labels: {
    username: string;
    password: string;
    signIn: string;
    continueWithGoogle: string;
    missingEnv: string;
    invalidPassword: string;
    googleConfig: string;
    googleState: string;
    googleFailed: string;
    googleNotFound: string;
    googleUnverified: string;
    googleDisabled: string;
  };
};

export function AdminLoginForm({
  missingEnv,
  errorCode,
  nextPath,
  googleEnabled,
  labels,
}: AdminLoginFormProps) {
  const toast = useToast();

  useEffect(() => {
    if (missingEnv) {
      toast.error(labels.missingEnv);
    }
  }, [labels.missingEnv, missingEnv, toast]);

  useEffect(() => {
    if (!errorCode) return;
    const message =
      errorCode === "1"
        ? labels.invalidPassword
        : errorCode === "google_config"
          ? labels.googleConfig
          : errorCode === "google_state"
            ? labels.googleState
            : errorCode === "google_not_found"
              ? labels.googleNotFound
              : errorCode === "google_unverified"
                ? labels.googleUnverified
                : errorCode === "google_disabled"
                  ? labels.googleDisabled
                  : labels.googleFailed;
    toast.error(message);
  }, [
    errorCode,
    labels.googleConfig,
    labels.googleDisabled,
    labels.googleFailed,
    labels.googleNotFound,
    labels.googleState,
    labels.googleUnverified,
    labels.invalidPassword,
    toast,
  ]);

  return (
    <form
      action="/api/admin/login"
      method="post"
      className="mt-2 w-full space-y-3"
    >
      <input type="hidden" name="next" value={nextPath} />
      <label className="block text-sm font-medium" htmlFor="username">
        {labels.username}
      </label>
      <input
        id="username"
        name="username"
        type="text"
        autoComplete="username"
        required
        className="h-12 w-full rounded-lg border bg-background/60 px-4 text-base outline-none ring-0 transition-colors focus:border-foreground/40"
      />
      <label className="block text-sm font-medium" htmlFor="password">
        {labels.password}
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        className="h-12 w-full rounded-lg border bg-background/60 px-4 text-base outline-none ring-0 transition-colors focus:border-foreground/40"
      />
      <div className="group relative mt-3">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <span className="text-foreground/85 absolute left-0 top-0 scale-[0.72] opacity-0 transition-all duration-220 ease-out group-hover:-translate-x-2.5 group-hover:-translate-y-2.5 group-hover:scale-100 group-hover:opacity-100">
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              className="block"
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
          <span
            className="text-foreground/85 absolute right-0 top-0 scale-[0.72] opacity-0 transition-all duration-220 ease-out group-hover:translate-x-2.5 group-hover:-translate-y-2.5 group-hover:scale-100 group-hover:opacity-100"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              className="block rotate-90"
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
          <span
            className="text-foreground/85 absolute bottom-0 left-0 scale-[0.72] opacity-0 transition-all duration-220 ease-out group-hover:-translate-x-2.5 group-hover:translate-y-2.5 group-hover:scale-100 group-hover:opacity-100"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              className="block -rotate-90"
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
          <span
            className="text-foreground/85 absolute bottom-0 right-0 scale-[0.72] opacity-0 transition-all duration-220 ease-out group-hover:translate-x-2.5 group-hover:translate-y-2.5 group-hover:scale-100 group-hover:opacity-100"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              className="block rotate-180"
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
        </div>
        <button
          type="submit"
          disabled={missingEnv}
          className="relative z-[1] h-12 w-full rounded-lg bg-foreground px-4 text-base font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
        >
          {labels.signIn}
        </button>
      </div>
      <div className="relative py-1 text-center text-xs text-muted-foreground">
        <span className="px-2">or</span>
        <div className="absolute inset-x-0 top-1/2 -z-10 h-px -translate-y-1/2 bg-border" />
      </div>
      <a
        href={`/api/admin/login/google?next=${encodeURIComponent(nextPath)}`}
        aria-disabled={!googleEnabled}
        className={`inline-flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-black/10 bg-white px-4 text-base font-medium text-[#1f1f1f] shadow-sm transition-colors dark:border-white/12 dark:bg-white dark:text-[#1f1f1f] ${
          googleEnabled
            ? "hover:bg-white/95"
            : "pointer-events-none cursor-not-allowed opacity-60"
        }`}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          className="shrink-0"
        >
          <path
            fill="#4285F4"
            d="M17.64 9.2045c0-.6382-.0573-1.2518-.1636-1.8409H9v3.4818h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9091c1.7023-1.5673 2.6832-3.8773 2.6832-6.6155Z"
          />
          <path
            fill="#34A853"
            d="M9 18c2.43 0 4.4673-.8059 5.9568-2.1791l-2.9091-2.2582c-.806  .54-1.8368.8591-3.0477.8591-2.3441 0-4.3282-1.5827-5.0364-3.7091H.96v2.3291A9 9 0 0 0 9 18Z"
          />
          <path
            fill="#FBBC05"
            d="M3.9636 10.7127A5.409 5.409 0 0 1 3.6818 9c0-.5959.1023-1.1759.2818-1.7127V4.9582H.96A9 9 0 0 0 0 9c0 1.4523.3477 2.8273.96 4.0418l3.0036-2.3291Z"
          />
          <path
            fill="#EA4335"
            d="M9 3.5782c1.3214 0 2.5077.4541 3.4418 1.3459l2.5814-2.5814C13.4632.8918 11.43 0 9 0A9 9 0 0 0 .96 4.9582l3.0036 2.3291C4.6718 5.1609 6.6559 3.5782 9 3.5782Z"
          />
        </svg>
        {labels.continueWithGoogle}
      </a>
    </form>
  );
}
