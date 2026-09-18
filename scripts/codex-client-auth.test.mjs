import assert from "node:assert/strict";
import test from "node:test";

import { buildChatgptBackendUrl } from "../src/openai-api/internal/backend-proxy.ts";
import zlib from "node:zlib";
import {
  classifyCodexBackendForward,
  isCodexBackendApiPath,
  isCodexResponsesPath,
  isPublicCodexClientPath,
} from "../src/server/utils/openai/codex-backend-alias.ts";
import { peekCodexRequestRecord } from "../src/server/routes/openai/codex-backend-forward-routes.ts";
import {
  createCodexClientSessionStore,
  createPkcePair,
  verifyPkce,
} from "../src/server/services/auth/codex-client-session.ts";

const apiKey = {
  id: "key-1",
  ownerUserId: "user-1",
  name: "Codex client",
  apiKey: "sk-test",
  quota: null,
  used: "0",
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test("codex backend paths stay on the subscription prefix", () => {
  assert.equal(isCodexBackendApiPath("/backend-api/codex/responses"), true);
  assert.equal(isCodexBackendApiPath("/backend-api/codex/models"), true);
  assert.equal(isCodexBackendApiPath("/v1/responses"), false);
  assert.equal(isCodexResponsesPath("/backend-api/codex/responses"), true);
  assert.equal(isCodexResponsesPath("/v1/responses"), false);
  assert.equal(classifyCodexBackendForward("/backend-api/codex/responses"), "responses");
  assert.equal(classifyCodexBackendForward("/backend-api/codex/images/generations"), "images");
  assert.equal(classifyCodexBackendForward("/backend-api/codex/alpha/search"), "search");
  assert.equal(classifyCodexBackendForward("/backend-api/codex/models"), "passthrough");
  assert.equal(isPublicCodexClientPath("/oauth/authorize"), true);
  assert.equal(isPublicCodexClientPath("/api/users"), false);
});

test("peekCodexRequestRecord reads json and zstd copies without rewriting", async () => {
  const payload = { model: "gpt-5.4", service_tier: "priority" };
  const raw = Buffer.from(JSON.stringify(payload));
  assert.deepEqual(await peekCodexRequestRecord(raw, undefined), payload);
  const compressed = await new Promise((resolve, reject) => {
    zlib.zstdCompress(raw, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  assert.deepEqual(await peekCodexRequestRecord(compressed, "zstd"), payload);
});

test("device oauth issues chatgpt-shaped tokens without upstream login", () => {
  const sessions = createCodexClientSessionStore({});
  const device = sessions.createDeviceCode();
  assert.equal(typeof device.interval, "string");
  sessions.approveDevice({
    userCode: device.user_code,
    apiKey,
    email: "alice@cocodex.local",
  });
  const polled = sessions.pollDeviceToken(device.device_auth_id, device.user_code);
  assert.equal(polled.status, "complete");
  const tokens = sessions.exchangeAuthorizationCode({
    code: polled.authorization_code,
    redirectUri: "/deviceauth/callback",
    codeVerifier: polled.code_verifier,
  });
  assert.ok(tokens);
  assert.equal(tokens.access_token, "sk-test");
  const payload = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString(),
  );
  assert.equal(payload.email, "alice@cocodex.local");
  assert.equal(payload["https://api.openai.com/auth"].chatgpt_plan_type, "pro");
});

test("backend forward only allows chatgpt backend-api urls", () => {
  assert.equal(
    buildChatgptBackendUrl("/backend-api/codex/guardian"),
    "https://chatgpt.com/backend-api/codex/guardian",
  );
  assert.throws(() => buildChatgptBackendUrl("/v1/responses"));
});

test("pkce verification matches s256", () => {
  const pair = createPkcePair();
  assert.equal(verifyPkce(pair.codeVerifier, pair.codeChallenge), true);
  assert.equal(verifyPkce("other", pair.codeChallenge), false);
});
