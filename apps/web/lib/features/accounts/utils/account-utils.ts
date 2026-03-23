import type { OpenAIAccountRecord, TeamAccountRecord } from "@workspace/database";
import type {
  AccountItem,
  AccountKind,
  AccountTranslationKey,
  SavedAccountSummary,
  SubmitMode,
  WorkspaceChoice,
} from "../types/account-types";

export const TEAM_OWNER_AUTO_FILL_TARGET = 5;

export function buildAccountItems(
  openaiAccounts: OpenAIAccountRecord[],
  teamAccounts: TeamAccountRecord[],
): AccountItem[] {
  const resolveAccountKind = (item: {
    accountUserRole: string | null;
    planType: string | null;
  }): AccountKind => {
    const role = (item.accountUserRole ?? "").trim().toLowerCase();
    const planType = (item.planType ?? "").trim().toLowerCase();
    if (planType === "team" && role === "account-owner") {
      return "team-owner";
    }
    if (planType === "team" && role === "standard-user") {
      return "team-member";
    }
    return "openai";
  };

  return [
    ...openaiAccounts.map((item) => ({ ...item, kind: resolveAccountKind(item) })),
    ...teamAccounts.map((item) => ({ ...item, kind: resolveAccountKind(item) })),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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

export function getKindLabel(kind: AccountKind, t: (key: AccountTranslationKey) => string) {
  if (kind === "openai") return t("accounts.kindOpenAI");
  if (kind === "team-owner") return t("accounts.kindTeamOwner");
  return t("accounts.kindTeamMember");
}

export function getStatusLabel(item: AccountItem, t: (key: AccountTranslationKey) => string) {
  if ("status" in item) {
    const status = (item.status ?? "").trim().toLowerCase();
    if (status === "disabled") return t("status.disabled");
    if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
      return t("status.coolingDown");
    }
    return t("status.active");
  }
  if (item.workspaceIsDeactivated) return t("status.disabled");
  if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
    return t("status.coolingDown");
  }
  return t("status.active");
}

export function getStatusVariant(item: AccountItem) {
  if ("status" in item) {
    const status = (item.status ?? "").trim().toLowerCase();
    if (status === "disabled") return "destructive" as const;
    if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
      return "outline" as const;
    }
    return "secondary" as const;
  }
  if (item.workspaceIsDeactivated) return "destructive" as const;
  if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
    return "outline" as const;
  }
  return "secondary" as const;
}

export function getStatusClassName(item: AccountItem) {
  if ("status" in item) {
    const status = (item.status ?? "").trim().toLowerCase();
    if (status === "disabled") return "";
    if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
      return "border-amber-200 bg-amber-100 text-amber-800";
    }
    return "border-emerald-200 bg-emerald-100 text-emerald-800";
  }
  if (item.workspaceIsDeactivated) return "";
  if (item.cooldownUntil && Date.parse(item.cooldownUntil) > Date.now()) {
    return "border-amber-200 bg-amber-100 text-amber-800";
  }
  return "border-emerald-200 bg-emerald-100 text-emerald-800";
}

export function emptyForm() {
  return {
    email: "",
    password: "",
    otpCode: "",
  };
}

export function resetLoginState() {
  return {
    form: emptyForm(),
    loginSessionId: null,
    requiresManualOtp: false,
    workspaceChoices: [] as WorkspaceChoice[],
    selectedWorkspaceId: "",
  };
}

export function shouldPromptTeamOwnerFill(
  account: SavedAccountSummary | null,
  mode: SubmitMode,
) {
  if (mode !== "create" || !account) return false;
  const planType = (account.planType ?? "").trim().toLowerCase();
  const role = (account.accountUserRole ?? "").trim().toLowerCase();
  const teamMemberCount = Number(account.teamMemberCount ?? 0);
  return (
    planType === "team" &&
    role === "account-owner" &&
    teamMemberCount < TEAM_OWNER_AUTO_FILL_TARGET
  );
}

export function selectContentProps() {
  return {
    position: "popper" as const,
    align: "start" as const,
    sideOffset: 4,
    className: "w-(--radix-select-trigger-width)",
  };
}

export function normalizeTeamMemberRole(role: string | null) {
  const normalized = (role ?? "").trim().toLowerCase();
  if (normalized === "account-owner" || normalized === "owner") return "团队拥有者";
  if (normalized === "standard-user" || normalized === "member") return "成员";
  if (!normalized) return "-";
  return normalized;
}

export function normalizeTeamMemberStatus(status: string | null) {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "pending") return "pending";
  if (normalized === "active") return "Active";
  if (normalized === "disabled") return "Disabled";
  return normalized || "-";
}
