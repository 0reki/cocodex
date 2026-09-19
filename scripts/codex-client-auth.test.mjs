import assert from "node:assert/strict";
import test from "node:test";

import { buildChatgptBackendUrl } from "../src/openai-api/internal/backend-proxy.ts";
import {
  classifyCodexBackendForward,
  isCodexBackendApiPath,
  isCodexResponsesPath,
  isPublicCodexClientPath,
} from "../src/server/utils/openai/codex-backend-alias.ts";
import {
  createCodexClientSessionStore,
  createPkcePair,
  verifyPkce,
} from "../src/server/services/auth/codex-client-session.ts";

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

test("device oauth issues chatgpt-shaped tokens without upstream login", async () => {
  const sessions = createCodexClientSessionStore({});
  const device = sessions.createDeviceCode();
  assert.equal(typeof device.interval, "string");
  sessions.approveDevice({
    userCode: device.user_code,
    ownerUserId: "user-1",
    email: "alice@openai.com",
  });
  const polled = sessions.pollDeviceToken(device.device_auth_id, device.user_code);
  assert.equal(polled.status, "complete");
  const tokens = await sessions.exchangeAuthorizationCode({
    code: polled.authorization_code,
    redirectUri: "/deviceauth/callback",
    codeVerifier: polled.code_verifier,
  });
  assert.ok(tokens);
  assert.notEqual(tokens.access_token, "sk-test");
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.account_id, "user-1");
  assert.match(tokens.refresh_token, /^rt\.1\./);
  assert.equal(tokens.access_token.split(".").length, 3);
  assert.equal(tokens.id_token.split(".").length, 3);
  const accessPayload = JSON.parse(
    Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
  );
  assert.equal(accessPayload.api_key_id, undefined);
  assert.equal(accessPayload["https://api.openai.com/auth"].chatgpt_account_id, "user-1");
  assert.deepEqual(accessPayload.aud, ["https://api.openai.com/v1"]);
  const payload = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString(),
  );
  assert.equal(payload.email, "alice@openai.com");
  assert.equal(payload["https://api.openai.com/auth"].chatgpt_plan_type, "pro");
  assert.equal(payload["https://api.openai.com/auth"].chatgpt_account_id, "user-1");
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
