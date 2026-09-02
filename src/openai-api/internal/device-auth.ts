import {
  CODEX_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_TOKEN_URL,
} from "./runtime-constants.ts";

const OPENAI_ACCOUNTS_API_URL = "https://auth.openai.com/api/accounts";
const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const CODEX_DEVICE_CALLBACK_URL =
  "https://auth.openai.com/deviceauth/callback";

type JsonRecord = Record<string, unknown>;

export type CodexDeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresInSeconds: number;
};

export type CodexDeviceAuthPollResult =
  | { status: "pending" }
  | {
      status: "complete";
      email: string;
      accountId: string;
      idToken: string;
      accessToken: string;
      refreshToken: string;
    };

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function stringValue(record: JsonRecord | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

async function readJson(response: Response, endpoint: string) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${endpoint} HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
    );
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    throw new Error(`Invalid JSON from ${endpoint}`);
  }
}

function parseIdTokenClaims(idToken: string) {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("Invalid ID token returned by OpenAI");
  try {
    return asRecord(JSON.parse(Buffer.from(payload, "base64url").toString()));
  } catch {
    throw new Error("Invalid ID token returned by OpenAI");
  }
}

export async function requestCodexDeviceCode(): Promise<CodexDeviceCode> {
  const response = await fetch(
    `${OPENAI_ACCOUNTS_API_URL}/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    },
  );
  if (response.status === 404) {
    throw new Error(
      "Device code login is not enabled for this ChatGPT account or workspace",
    );
  }
  const payload = await readJson(response, "/deviceauth/usercode");
  const deviceAuthId = stringValue(payload, "device_auth_id");
  const userCode =
    stringValue(payload, "user_code") || stringValue(payload, "usercode");
  const interval = Number(payload?.interval);
  if (!deviceAuthId || !userCode) {
    throw new Error("Invalid device code response from OpenAI");
  }

  return {
    deviceAuthId,
    userCode,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    intervalSeconds:
      Number.isFinite(interval) && interval > 0 ? Math.trunc(interval) : 5,
    expiresInSeconds: 15 * 60,
  };
}

export async function pollCodexDeviceAuth(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<CodexDeviceAuthPollResult> {
  const pollResponse = await fetch(
    `${OPENAI_ACCOUNTS_API_URL}/deviceauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    },
  );
  if (pollResponse.status === 403 || pollResponse.status === 404) {
    return { status: "pending" };
  }

  const codePayload = await readJson(pollResponse, "/deviceauth/token");
  const authorizationCode = stringValue(codePayload, "authorization_code");
  const codeVerifier = stringValue(codePayload, "code_verifier");
  if (!authorizationCode || !codeVerifier) {
    throw new Error("Invalid device authorization response from OpenAI");
  }

  const tokenResponse = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: CODEX_DEVICE_CALLBACK_URL,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  const tokenPayload = await readJson(tokenResponse, "/oauth/token");
  const idToken = stringValue(tokenPayload, "id_token");
  const accessToken = stringValue(tokenPayload, "access_token");
  const refreshToken = stringValue(tokenPayload, "refresh_token");
  if (!idToken || !accessToken || !refreshToken) {
    throw new Error("OpenAI token response is incomplete");
  }

  const claims = parseIdTokenClaims(idToken);
  const profile = asRecord(claims?.["https://api.openai.com/profile"]);
  const auth = asRecord(claims?.["https://api.openai.com/auth"]);
  const email = stringValue(claims, "email") || stringValue(profile, "email");
  const accountId =
    stringValue(auth, "chatgpt_account_id") ||
    stringValue(claims, "chatgpt_account_id");
  if (!email || !accountId) {
    throw new Error("OpenAI ID token is missing account information");
  }

  return {
    status: "complete",
    email,
    accountId,
    idToken,
    accessToken,
    refreshToken,
  };
}
