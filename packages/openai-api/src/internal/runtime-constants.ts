export const CHATGPT_SESSION_URL = "https://chatgpt.com/api/auth/session";
export const CHATGPT_ACCOUNTS_CHECK_V4_URL =
  "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
export const CHATGPT_ME_URL = "https://chatgpt.com/backend-api/me";
export const CHATGPT_SUBSCRIPTIONS_URL =
  "https://chatgpt.com/backend-api/subscriptions";
export const CHATGPT_ACCOUNT_USERS_URL =
  "https://chatgpt.com/backend-api/accounts";
export const CHATGPT_CODEX_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
export const CHATGPT_WHAM_USAGE_URL =
  "https://chatgpt.com/backend-api/wham/usage";
export const CHATGPT_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const CHATGPT_CODEX_RESPONSES_WS_URL =
  "wss://chatgpt.com/backend-api/codex/responses";
export const CHATGPT_CODEX_RESPONSES_COMPACT_URL =
  "https://chatgpt.com/backend-api/codex/responses/compact";
export const CHATGPT_TRANSCRIBE_URL =
  "https://chatgpt.com/backend-api/transcribe";
export const DEFAULT_USER_AGENT = "Apifox/1.0.0 (https://apifox.com)";
export const DEFAULT_CODEX_ORIGINATOR = "codex_cli_rs";
export const DEFAULT_CODEX_SANDBOX = "windows_elevated";
export const DEFAULT_CODEX_SENTRY_ENVIRONMENT =
  process.env.CODEX_SENTRY_ENVIRONMENT?.trim() || "production";
export const DEFAULT_CODEX_SENTRY_RELEASE =
  process.env.CODEX_SENTRY_RELEASE?.trim() || "1.24.2";
export const DEFAULT_CODEX_SENTRY_PUBLIC_KEY =
  process.env.CODEX_SENTRY_PUBLIC_KEY?.trim() ||
  "5838a5520ad44602ae46793727e49ef5";
