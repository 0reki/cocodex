import type { SessionTokenCookieMap } from "@workspace/openai-api";

export type SignupRunOptions = {
  count: number;
  concurrency: number;
  proxyPool?: string[];
  mailProvider?: SignupMailProvider;
};

export type SignupBatchOptions = Partial<SignupRunOptions> & {
  onResult?: (result: SignupRunResult) => void | Promise<void>;
  includeResults?: boolean;
};

export type SignupSessionResult = {
  email: string;
  session_cookies: Record<string, string>;
  captured_at: string;
};

export type SignupRunResult = {
  runId: number;
  ok: boolean;
  email: string;
  durationMs: number;
  attempts: number;
  error?: string;
  sessionResult?: SignupSessionResult;
  account?: SignupAccountRecord;
};

export type SignupBatchResult = {
  total: number;
  successCount: number;
  failedCount: number;
  wallClockMs: number;
  averageRunMs: number;
  results: SignupRunResult[];
};

export type SignupMailProvider = {
  generateEmail: () => Promise<string>;
  waitForOtp: (
    email: string,
    timeoutMs?: number,
    pollIntervalMs?: number,
  ) => Promise<string>;
  prepareForRetry?: (email: string) => Promise<void> | void;
  abandonEmail?: (email: string, reason: string) => Promise<void> | void;
  dispose?: () => void;
};

export type SignupAccountRecord = {
  email: string;
  userId: string | null;
  name: string | null;
  picture: string | null;
  accountId: string | null;
  accountUserRole: string | null;
  workspaceName: string | null;
  planType: string | null;
  workspaceIsDeactivated: boolean;
  workspaceCancelledAt: string | null;
  status: string | null;
  isShared: boolean;
  password: string;
  accessToken: string;
  sessionToken: string | null;
  refreshToken: string | null;
  type: "openai";
  sessionTokenCookies: SessionTokenCookieMap;
};

export interface MainToWorkerMessage {
  type: "run" | "stop";
  runId?: number;
  proxyUrl?: string;
  proxyPool?: string[];
}

export interface WorkerToMainMessage {
  type: "ready" | "result";
  result?: SignupRunResult;
}

export type HeaderLike = {
  get: (name: string) => string | null;
  getSetCookie?: () => string[];
};

export interface OAuthBootstrap {
  loginVerifier?: string;
  authSessionLoggingId?: string;
  continueUrl?: string;
}
