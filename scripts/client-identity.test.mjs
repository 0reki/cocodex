import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  buildCodexUserAgent,
  createCodexVersionResolver,
} from "../src/openai-api/internal/client-identity.ts";
import { buildCodexTransportHeaders } from "../src/openai-api/internal/runtime-codex.ts";
import { getCodexModels } from "../src/openai-api/internal/accounts.ts";
import { getCodexUsage, getCodexDailyWorkspaceUsage } from "../src/openai-api/internal/usage.ts";
import { refreshCodexTokens } from "../src/openai-api/internal/auth.ts";
import { requestCodexDeviceCode, pollCodexDeviceAuth } from "../src/openai-api/internal/device-auth.ts";

const HOUR = 3_600_000;
const stable = (version, headers) => Response.json({
  tag_name: `rust-v${version}`, draft: false, prerelease: false,
}, { headers });

function fixture(fetch, env = {}) {
  let now = 0;
  const warnings = [];
  const resolver = createCodexVersionResolver({
    fetch, env, now: () => now, warn: (message) => warnings.push(message),
  });
  return { ...resolver, warnings, advance: (ms) => { now += ms; } };
}

test("anonymous refresh is nonblocking, coalesced, cached, and uses ETag", async () => {
  const requests = [];
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const resolver = fixture(async (url, options) => {
    requests.push({ url, ...options });
    return requests.length === 1 ? pending : new Response(null, { status: 304 });
  });
  const fallback = resolver.getVersion();
  for (let i = 0; i < 30; i++) assert.equal(resolver.getVersion(), fallback);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/repos/openai/codex/releases/latest");
  assert.equal(requests[0].headers.has("authorization"), false);
  resolve(stable("0.200.0", { etag: '"release-1"' }));
  await setImmediate();
  assert.equal(resolver.getVersion(), "0.200.0");
  resolver.advance(6 * HOUR - 1);
  resolver.getVersion();
  assert.equal(requests.length, 1);
  resolver.advance(1);
  assert.equal(resolver.getVersion(), "0.200.0");
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.get("if-none-match"), '"release-1"');
  resolver.getVersion();
  assert.equal(requests.length, 2);
  assert.deepEqual(resolver.warnings, []);
});

test("pinning disables GitHub and rejects malformed versions", () => {
  const env = { CODEX_CLIENT_VERSION: "0.199.1" };
  const resolver = fixture(() => { assert.fail("must not fetch"); }, env);
  assert.equal(resolver.getVersion(), "0.199.1");
  env.CODEX_CLIENT_VERSION = "invalid";
  assert.throws(() => resolver.getVersion(), /CODEX_CLIENT_VERSION/);
});

test("rate limiting keeps the last success and respects both retry headers", async () => {
  let calls = 0;
  const resolver = fixture(async (_url, { headers }) => {
    assert.equal(headers.get("authorization"), "Bearer test-token");
    calls++;
    return calls === 1 ? stable("0.201.0") : new Response("rate limited", {
      status: 429, headers: { "retry-after": "7200", "x-ratelimit-reset": "32400" },
    });
  }, { CODEX_GITHUB_TOKEN: "test-token" });
  resolver.getVersion();
  await setImmediate();
  resolver.advance(6 * HOUR);
  assert.equal(resolver.getVersion(), "0.201.0");
  await setImmediate();
  resolver.advance(3 * HOUR - 1);
  assert.equal(resolver.getVersion(), "0.201.0");
  assert.equal(calls, 2);
  resolver.advance(1);
  resolver.getVersion();
  assert.equal(calls, 3);
  await setImmediate();
  assert.ok(resolver.warnings.every((message) => !message.includes("test-token")));
});

test("network failure and invalid releases retain fallback and back off", async () => {
  for (const response of [
    () => { throw new Error("secret-token network failure"); },
    () => Response.json({ tag_name: "rust-v0.202.0-alpha.1", draft: false, prerelease: true }),
    () => Response.json({ tag_name: "rust-v0.202.0", draft: true, prerelease: false }),
    () => Response.json(null),
    () => new Response("not JSON"),
    () => new Response("unauthorized", { status: 401 }),
  ]) {
    let calls = 0;
    const resolver = fixture(async () => { calls++; return response(); });
    const fallback = resolver.getVersion();
    await setImmediate();
    assert.equal(resolver.getVersion(), fallback);
    resolver.advance(HOUR - 1);
    resolver.getVersion();
    assert.equal(calls, 1);
    resolver.advance(1);
    resolver.getVersion();
    assert.equal(calls, 2);
    await setImmediate();
    assert.ok(resolver.warnings.every((message) => !message.includes("secret-token")));
  }
});

test("proxy UA follows the forwarded version while credentials remain account-bound", () => {
  for (const userAgent of ["Apifox/1.0.0", "node/22.14.0", "codex-tui/0.200.0"]) {
    const headers = buildCodexTransportHeaders({
      accessToken: "upstream-token", accountId: "assigned-account", sessionId: "session",
      version: "0.199.0", userAgent: "ignored-override",
      requestHeaders: {
        "user-agent": userAgent, version: "0.200.0", authorization: "Bearer client-key",
        "chatgpt-account-id": "client-account", "x-custom": "preserved",
      },
    });
    assert.equal(headers["user-agent"], buildCodexUserAgent("0.200.0"));
    assert.equal(headers.authorization, "Bearer upstream-token");
    assert.equal(headers["chatgpt-account-id"], "assigned-account");
    assert.equal(headers["x-custom"], "preserved");
    assert.equal(headers.version, "0.200.0");
  }
  const headers = buildCodexTransportHeaders({
    accessToken: "token", sessionId: "session", version: "0.201.0", requestHeaders: {},
  });
  assert.equal(headers["user-agent"], buildCodexUserAgent("0.201.0"));
});

test("models, usage and all OAuth calls send Codex UA without leaking GitHub token", async (t) => {
  const previousVersion = process.env.CODEX_CLIENT_VERSION;
  const previousToken = process.env.CODEX_GITHUB_TOKEN;
  process.env.CODEX_CLIENT_VERSION = "0.200.0";
  process.env.CODEX_GITHUB_TOKEN = "github-only-test-secret";
  t.after(() => {
    if (previousVersion === undefined) delete process.env.CODEX_CLIENT_VERSION;
    else process.env.CODEX_CLIENT_VERSION = previousVersion;
    if (previousToken === undefined) delete process.env.CODEX_GITHUB_TOKEN;
    else process.env.CODEX_GITHUB_TOKEN = previousToken;
  });
  const calls = [];
  const claims = Buffer.from(JSON.stringify({
    email: "test@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "account" },
  })).toString("base64url");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return Response.json({
      models: [], device_auth_id: "device", user_code: "code", interval: 5,
      authorization_code: "code", code_verifier: "verifier",
      id_token: `header.${claims}.signature`, access_token: "access", refresh_token: "refresh",
    });
  });
  const options = { accessToken: "token", clientVersion: "0.200.0", userAgent: "legacy-ua" };
  await getCodexModels(options);
  await getCodexUsage(options);
  await getCodexDailyWorkspaceUsage({ ...options, startDate: "2026-01-01", endDate: "2026-01-02" });
  await refreshCodexTokens({ refreshToken: "refresh", userAgent: "legacy-ua" });
  await requestCodexDeviceCode();
  await pollCodexDeviceAuth({ deviceAuthId: "device", userCode: "code" });
  assert.equal(calls.length, 7);
  for (const { url, headers } of calls) {
    assert.equal(headers.get("user-agent"), buildCodexUserAgent("0.200.0"), url);
    assert.ok(!url.includes("github.com"));
    assert.ok(!JSON.stringify([...headers]).includes("github-only-test-secret"));
  }
});
