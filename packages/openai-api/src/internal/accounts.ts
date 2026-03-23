import {
  CHATGPT_ACCOUNT_USERS_URL,
  CHATGPT_CODEX_MODELS_URL,
  CHATGPT_ME_URL,
  CHATGPT_SUBSCRIPTIONS_URL,
  CHATGPT_WHAM_USAGE_URL,
  DEFAULT_USER_AGENT,
} from "./runtime-constants.ts"
import { fetchWithOptionalProxy } from "./runtime-proxy.ts"
import type {
  ChatgptAccountInvite,
  ChatgptAccountInvitesResponse,
  ChatgptMeResponse,
  ChatgptAccountUsersResponse,
  ChatgptSubscriptionResponse,
  CodexModelsResponse,
  CreateAccountInvitesOptions,
  DeleteAccountInviteOptions,
  DeleteAccountUserOptions,
  GetCodexModelsOptions,
  GetMeOptions,
  GetSubscriptionOptions,
  GetWhamUsageOptions,
  ListAccountInvitesOptions,
  ListAccountUsersOptions,
  WhamUsageResponse,
} from "./runtime-types.ts"

export async function getMe(options: GetMeOptions): Promise<ChatgptMeResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();

  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }
  const requestHeaders = {
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "*/*",
    Authorization: `Bearer ${accessToken}`,
    Host: "chatgpt.com",
    Connection: "keep-alive",
    "chatgpt-account-id": accountId,
  };

  console.info(`[openai-api] me request url=${CHATGPT_ME_URL}`);
  console.info(
    `[openai-api] me request_headers=${JSON.stringify(requestHeaders)}`,
  );

  const res = await fetchWithOptionalProxy(
    CHATGPT_ME_URL,
    {
      method: "GET",
      headers: requestHeaders,
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  console.info(`[openai-api] me response_status=${res.status}`);
  if (!res.ok) {
    throw new Error(
      `/backend-api/me HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as ChatgptMeResponse;
  } catch {
    throw new Error(`Invalid JSON from /backend-api/me: ${text.slice(0, 500)}`);
  }
}

export async function getSubscription(
  options: GetSubscriptionOptions,
): Promise<ChatgptSubscriptionResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();

  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }

  const url = `${CHATGPT_SUBSCRIPTIONS_URL}?account_id=${encodeURIComponent(accountId)}`;
  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `/backend-api/subscriptions HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as ChatgptSubscriptionResponse;
  } catch {
    throw new Error(
      `Invalid JSON from /backend-api/subscriptions: ${text.slice(0, 500)}`,
    );
  }
}

export async function listAccountUsers(
  options: ListAccountUsersOptions,
): Promise<ChatgptAccountUsersResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }

  const offset = Math.max(0, Math.trunc(Number(options.offset ?? 0)));
  const limit = Math.max(1, Math.trunc(Number(options.limit ?? 25)));
  const query = typeof options.query === "string" ? options.query : "";
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const url =
    `${CHATGPT_ACCOUNT_USERS_URL}/${encodeURIComponent(accountId)}/users` +
    `?offset=${offset}&limit=${limit}&query=${encodeURIComponent(query)}`;

  console.error(
    `[openai-api] listAccountUsers ua=${JSON.stringify(userAgent)} transport=${options.proxyUrl ? "undici-proxy" : "native-fetch"}`,
  );

  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Accept: "*/*",
        Host: "chatgpt.com",
        Connection: "keep-alive",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `/backend-api/accounts/${accountId}/users HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as ChatgptAccountUsersResponse;
  } catch {
    throw new Error(
      `Invalid JSON from /backend-api/accounts/${accountId}/users: ${text.slice(0, 500)}`,
    );
  }
}

export async function deleteAccountUser(
  options: DeleteAccountUserOptions,
): Promise<{ success?: boolean }> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  const userId = options.userId.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }
  if (!userId) {
    throw new Error("Missing userId");
  }

  const url =
    `${CHATGPT_ACCOUNT_USERS_URL}/${encodeURIComponent(accountId)}/users/` +
    `${encodeURIComponent(userId)}`;

  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "DELETE",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `DELETE /backend-api/accounts/${accountId}/users/${userId} HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as { success?: boolean };
  } catch {
    throw new Error(
      `Invalid JSON from DELETE /backend-api/accounts/${accountId}/users/${userId}: ${text.slice(0, 500)}`,
    );
  }
}

export async function listAccountInvites(
  options: ListAccountInvitesOptions,
): Promise<ChatgptAccountInvitesResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }

  const url = `${CHATGPT_ACCOUNT_USERS_URL}/${encodeURIComponent(accountId)}/invites`;
  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "application/json",
        Host: "chatgpt.com",
        Connection: "keep-alive",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `/backend-api/accounts/${accountId}/invites HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as ChatgptAccountInvitesResponse;
  } catch {
    throw new Error(
      `Invalid JSON from /backend-api/accounts/${accountId}/invites: ${text.slice(0, 500)}`,
    );
  }
}

export async function createAccountInvites(
  options: CreateAccountInvitesOptions,
): Promise<ChatgptAccountInvitesResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  const emailAddresses = Array.from(
    new Set(options.emailAddresses.map((item) => item.trim().toLowerCase()).filter(Boolean)),
  );
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }
  if (emailAddresses.length === 0) {
    throw new Error("Missing emailAddresses");
  }

  const url = `${CHATGPT_ACCOUNT_USERS_URL}/${encodeURIComponent(accountId)}/invites`;
  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "POST",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "*/*",
        "Content-Type": "application/json",
        Host: "chatgpt.com",
        Connection: "keep-alive",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      body: JSON.stringify({
        email_addresses: emailAddresses,
        role: options.role?.trim() || "standard-user",
        resend_email: options.resendEmail === true,
      }),
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `POST /backend-api/accounts/${accountId}/invites HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as ChatgptAccountInvitesResponse;
  } catch {
    throw new Error(
      `Invalid JSON from POST /backend-api/accounts/${accountId}/invites: ${text.slice(0, 500)}`,
    );
  }
}

export async function deleteAccountInvite(
  options: DeleteAccountInviteOptions,
): Promise<{ success?: boolean; invite?: ChatgptAccountInvite | null; [key: string]: unknown }> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  const emailAddress = options.emailAddress.trim().toLowerCase();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }
  if (!emailAddress) {
    throw new Error("Missing emailAddress");
  }

  const url = `${CHATGPT_ACCOUNT_USERS_URL}/${encodeURIComponent(accountId)}/invites`;
  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "DELETE",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "*/*",
        "Content-Type": "application/json",
        Host: "chatgpt.com",
        Connection: "keep-alive",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      body: JSON.stringify({
        email_address: emailAddress,
      }),
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `DELETE /backend-api/accounts/${accountId}/invites HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as {
      success?: boolean;
      invite?: ChatgptAccountInvite | null;
      [key: string]: unknown;
    };
  } catch {
    throw new Error(
      `Invalid JSON from DELETE /backend-api/accounts/${accountId}/invites: ${text.slice(0, 500)}`,
    );
  }
}

export async function getCodexModels(
  options: GetCodexModelsOptions,
): Promise<CodexModelsResponse> {
  const accessToken = options.accessToken.trim();
  const clientVersion = options.clientVersion.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!clientVersion) {
    throw new Error("Missing clientVersion");
  }

  const url = `${CHATGPT_CODEX_MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`;

  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `/backend-api/codex/models HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as CodexModelsResponse;
  } catch {
    throw new Error(
      `Invalid JSON from /backend-api/codex/models: ${text.slice(0, 500)}`,
    );
  }
}

export async function getWhamUsage(
  options: GetWhamUsageOptions,
): Promise<WhamUsageResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!accountId) {
    throw new Error("Missing accountId");
  }

  const res = await fetchWithOptionalProxy(
    CHATGPT_WHAM_USAGE_URL,
    {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `/backend-api/wham/usage HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as WhamUsageResponse;
  } catch {
    throw new Error(
      `Invalid JSON from /backend-api/wham/usage: ${text.slice(0, 500)}`,
    );
  }
}
