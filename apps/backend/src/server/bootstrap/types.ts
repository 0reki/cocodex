import type {
  ApiKeyRecord,
  OpenAIAccountRecord,
  TeamAccountRecord,
  getPortalUserSpendAllowance,
} from "@workspace/database";

import type { WsSocket } from "../utils/network/ws.ts";

export type PortalUserSpendAllowanceValue = Awaited<
  ReturnType<typeof getPortalUserSpendAllowance>
>;

export type RateLimitSource = {
  id?: string | null;
  email: string;
  accessToken: string | null;
  sessionToken?: string | null;
  refreshToken?: string | null;
  accountId: string | null;
  userId: string | null;
  proxyId?: string | null;
  rateLimit?: Record<string, unknown> | null;
};

export type OpenAIApiRuntimeConfig = {
  userAgent: string;
  clientVersion: string;
};

export type OpenAIUpstreamRequestTrace = {
  sourceAccountId?: string | null;
  sourceAccountEmail?: string | null;
  sourceProxyId?: string | null;
  selectedUpstreamAccountId?: string | null;
  selectedProxyUrl?: string | null;
};

export type OpenAIApiModule = {
  postCodexResponses?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    payload?: Record<string, unknown> | null;
    debugLabel?: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<globalThis.Response>;
  postCodexResponsesCompact?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    payload?: Record<string, unknown> | null;
    debugLabel?: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<globalThis.Response>;
  connectCodexResponsesWebSocket?: (args: {
    accessToken: string;
    accountId?: string;
    version: string;
    sessionId: string;
    serviceTier?: "priority";
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<WsSocket>;
  postAudioTranscription?: (args: {
    accessToken: string;
    accountId: string;
    contentType: string;
    body: BodyInit;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<globalThis.Response>;
  getAccessToken?: (args: {
    sessionToken?: string;
    sessionTokenChunks?: string[];
    cookieHeader?: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{
    accessToken?: string;
    session?: Record<string, unknown>;
    sessionTokenCookies?: Record<string, string | undefined>;
  }>;
  getWhamUsage?: (args: {
    accessToken: string;
    accountId: string;
    proxyUrl?: string;
    userAgent?: string;
    signal?: AbortSignal;
  }) => Promise<{
    rate_limit?: Record<string, unknown>;
  }>;
};

export type V1ModelObject = {
  id: string;
  created: number;
  object: "model";
  owned_by: string;
};

export type ApiKeysCacheState = {
  loaded: boolean;
  items: ApiKeyRecord[];
  byToken: Map<string, ApiKeyRecord[]>;
  loadingPromise: Promise<void> | null;
};

export type AccountsLruState<TAccount extends OpenAIAccountRecord | TeamAccountRecord> = {
  loaded: boolean;
  items: Map<string, TAccount>;
  maxSize: number;
  refreshSeconds: number;
  loadedAtMs: number;
  loadingPromise: Promise<void> | null;
};
