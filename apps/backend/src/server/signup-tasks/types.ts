import type {
  SignupAccountRecord as WorkspaceSignupAccountRecord,
  SignupBatchResult as WorkspaceSignupBatchResult,
} from "@workspace/openai-signup";

export type SignupFlowAccount = WorkspaceSignupAccountRecord;

export type SignupFlowResult = {
  ok?: boolean;
  account?: SignupFlowAccount;
};

export type SignupBatchResult = WorkspaceSignupBatchResult;

type SignupTaskStatus = "pending" | "running" | "completed" | "failed";
export type SignupTaskControlStatus = SignupTaskStatus | "stopping" | "stopped";
export type SignupTaskKind =
  | "openai"
  | "team-member"
  | "team-member-fill"
  | "team-member-join"
  | "team-owner";

export type SignupTask = {
  id: string;
  kind: SignupTaskKind;
  status: SignupTaskControlStatus;
  count: number;
  concurrency: number;
  cpuMaxConcurrency: number;
  proxyPoolSize: number;
  savedCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: SignupFlowResult | SignupBatchResult | Record<string, unknown> | null;
  error: string | null;
};

export type TeamMemberSignupExecutionResult = {
  flowResult: SignupBatchResult;
  invitedCount: number;
  createdCount: number;
  failedCount: number;
  saveFailures: string[];
  createdEmails: string[];
};

export type TeamOwnerSignupExecutionResult = {
  flowResult: SignupBatchResult;
  createdCount: number;
  failedCount: number;
  saveFailures: string[];
};

export type SignupTaskControl = {
  proxyPool: string[];
  stopRequested: boolean;
  requesterUserId?: string;
  cloudMailDomains?: string[];
  ownerMailDomains?: string[];
  memberEmails?: string[];
  ownerEmail?: string;
  portalUserId?: string;
};

export type SignupTaskState = {
  tasks: Map<string, SignupTask>;
  queue: string[];
  control: Map<string, SignupTaskControl>;
  scheduler: {
    runningWorkers: number;
    maxWorkers: number;
  };
};

export function summarizeSignupResult(
  result: SignupFlowResult | SignupBatchResult | null,
) {
  if (!result) return null;
  if ("results" in result && Array.isArray(result.results)) {
    return {
      total: result.total ?? result.results.length,
      successCount: result.successCount ?? 0,
      failedCount: result.failedCount ?? 0,
      wallClockMs: result.wallClockMs ?? null,
      averageRunMs: result.averageRunMs ?? null,
    };
  }
  if ("account" in result && result.account) {
    return {
      ok: result.ok ?? null,
      account: {
        email: result.account.email,
      },
    };
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
