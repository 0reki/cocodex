import { useEffect, useState } from "react";
import type { TeamAccountRecord } from "@workspace/database";
import type { TeamTab } from "../types/team-types";

export const TEAM_OWNER_AUTO_FILL_TARGET = 5;

export function getStatusLabel(item: TeamAccountRecord, t: (key: any) => string) {
  if (item.workspaceIsDeactivated) return t("status.disabled");
  if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
    return t("status.coolingDown");
  }
  return t("status.active");
}

export function getStatusVariant(item: TeamAccountRecord) {
  if (item.workspaceIsDeactivated) return "destructive" as const;
  if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
    return "outline" as const;
  }
  return "secondary" as const;
}

export function getStatusClassName(item: TeamAccountRecord) {
  if (item.workspaceIsDeactivated) return "";
  if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
    return "border-amber-200 bg-amber-100 text-amber-800";
  }
  return "border-emerald-200 bg-emerald-100 text-emerald-800";
}

export function getRateLimitWindows(rateLimit: Record<string, unknown> | null) {
  if (!rateLimit || typeof rateLimit !== "object") return [];
  const windows = [
    rateLimit.primary_window as Record<string, unknown> | null | undefined,
    rateLimit.secondary_window as Record<string, unknown> | null | undefined,
  ];
  return windows
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    )
    .map((item) => ({
      usedPercent: Number(item.used_percent),
      limitWindowSeconds: Number(item.limit_window_seconds),
      resetAfterSeconds: Number(item.reset_after_seconds),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.usedPercent) &&
        Number.isFinite(item.limitWindowSeconds) &&
        Number.isFinite(item.resetAfterSeconds),
    );
}

export function toPercent(value?: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value ?? 0));
}

export function windowLabel(seconds?: number) {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function formatResetAfter(seconds?: number) {
  if (!Number.isFinite(seconds) || seconds == null || seconds <= 0) return "-";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainSeconds = Math.round(seconds % 60);
    return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const remainMinutes = Math.round((seconds % 3600) / 60);
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

export function formatDateTime(value: string | null) {
  if (!value) return "-";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

export function LocalDateTime({ value }: { value: string | null }) {
  const [formatted, setFormatted] = useState(() => formatDateTime(value));

  useEffect(() => {
    setFormatted(formatDateTime(value));
  }, [value]);

  return <span suppressHydrationWarning>{formatted}</span>;
}

export function buildHref(args: {
  tab: TeamTab;
  page: number;
  pageSize: number;
  q?: string;
}) {
  const params = new URLSearchParams({
    tab: args.tab,
    page: String(args.page),
    pageSize: String(args.pageSize),
  });
  if (args.q?.trim()) {
    params.set("q", args.q.trim());
  }
  return `/team?${params.toString()}`;
}
