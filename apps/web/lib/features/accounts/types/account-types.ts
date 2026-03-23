import type { OpenAIAccountRecord, TeamAccountRecord } from "@workspace/database";

export type AccountKind = "openai" | "team-owner" | "team-member";
export type AccountFilterKind = "all" | AccountKind | "plus";
export type AccountItem = (OpenAIAccountRecord | TeamAccountRecord) & { kind: AccountKind };

export type ConfirmDialogState = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive";
  action: null | (() => Promise<void>);
};

export type SubmitMode = "create" | "relogin";

export type WorkspaceChoice = {
  id: string;
  name: string | null;
  kind: string | null;
  planType: string | null;
};

export type SavedAccountSummary = {
  email: string;
  accountUserRole: string | null;
  planType: string | null;
  teamMemberCount: number | null;
};

export type TeamOwnerAvailableSlotsResponse = {
  ok?: boolean;
  error?: string;
  teamMemberCount?: number;
  pendingInvites?: number;
  availableSlots?: number;
};

export type TeamOwnerFillState = {
  availableSlots: number;
  missingMembers: number;
};

export type TeamOwnerMemberItem = {
  id: string;
  email: string;
  role: string | null;
  name: string | null;
  status: string | null;
};

export type AccountTranslationKey =
  | "accounts.kindOpenAI"
  | "accounts.kindTeamOwner"
  | "accounts.kindTeamMember"
  | "accounts.kindPlus"
  | "accounts.autoFillMembersTitle"
  | "accounts.autoFillMembersDescription"
  | "accounts.autoFillMembersConfirm"
  | "accounts.autoFillMembersQueued"
  | "accounts.autoFillMembersQueueFailed"
  | "status.active"
  | "status.disabled"
  | "status.coolingDown";
