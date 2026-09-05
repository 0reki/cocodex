import {
  CHATGPT_CODEX_DAILY_USAGE_URL,
  CHATGPT_CODEX_USAGE_URL,
  DEFAULT_CODEX_ORIGINATOR,
} from "./runtime-constants.ts";
import { buildCodexUserAgent } from "./client-identity.ts";
import type {
  GetCodexDailyWorkspaceUsageOptions,
  GetCodexUsageOptions,
} from "./runtime-types.ts";

function codexUsageHeaders(options: GetCodexUsageOptions) {
  const accessToken = options.accessToken.trim();
  const clientVersion = options.clientVersion.trim();
  if (!accessToken) throw new Error("Missing accessToken");
  if (!clientVersion) throw new Error("Missing clientVersion");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    originator: DEFAULT_CODEX_ORIGINATOR,
    "User-Agent": buildCodexUserAgent(clientVersion),
  };
  const accountId = options.accountId?.trim();
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

function analyticsUsageHeaders(options: GetCodexUsageOptions) {
  const accessToken = options.accessToken.trim();
  const clientVersion = options.clientVersion.trim();
  if (!accessToken) throw new Error("Missing accessToken");
  if (!clientVersion) throw new Error("Missing clientVersion");

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "OpenAI-Beta": "codex-1",
    originator: "codex-tui",
    "User-Agent": buildCodexUserAgent(clientVersion),
    version: clientVersion,
  };
  const accountId = options.accountId?.trim();
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

async function getUsageJson(
  url: string,
  path: string,
  options: GetCodexUsageOptions,
  headers: Record<string, string>,
) {
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("response is not a JSON object");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getCodexUsage(options: GetCodexUsageOptions) {
  return getUsageJson(
    CHATGPT_CODEX_USAGE_URL,
    "/backend-api/wham/usage",
    options,
    codexUsageHeaders(options),
  );
}

export function getCodexDailyWorkspaceUsage(
  options: GetCodexDailyWorkspaceUsageOptions,
) {
  const url = new URL(CHATGPT_CODEX_DAILY_USAGE_URL);
  url.searchParams.set("start_date", options.startDate);
  url.searchParams.set("end_date", options.endDate);
  url.searchParams.set("group_by", "day");
  url.searchParams.set("workspace_user", "true");
  return getUsageJson(
    url.toString(),
    "/backend-api/wham/analytics/daily-workspace-usage-counts",
    options,
    analyticsUsageHeaders(options),
  );
}
