import crypto from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";

import pg from "pg";
import WebSocket from "ws";

const { Client } = pg;

const MODEL = "gpt-5.6-luna";
const IMAGE_MODEL = "gpt-image-2";
const CLIENT_VERSION = "0.152.0";
const SERVER_LOG_LIMIT = 32 * 1024;
const HTTP_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 180_000;
const IMAGE_TIMEOUT_MS = 300_000;

const secrets = new Set();

function requiredEnv(name, fallbackName) {
  const value = (process.env[name] ?? (fallbackName ? process.env[fallbackName] : ""))?.trim();
  if (!value) throw new Error(`${name} is required`);
  secrets.add(value);
  return value;
}

function booleanEnv(name, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function integerEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function redact(value) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 6) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[REDACTED]@");
}

function snippet(value, maximum = 1_000) {
  const text = redact(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withStep(label, operation) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    console.log(`✓ ${label} (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`, { cause: error });
  }
}

function databaseUrlWithSchema(databaseUrl, schema) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

async function createSchema(databaseUrl, schema) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}" AUTHORIZATION CURRENT_USER`);
  } finally {
    await client.end();
  }
}

async function dropSchema(databaseUrl, schema) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

async function loadSourceAccountFixture(databaseUrl, email) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT account_id, access_token, refresh_token
       FROM public.openai_accounts
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    assert(row, `source account fixture ${email} was not found`);
    for (const field of ["account_id", "access_token", "refresh_token"]) {
      assert(typeof row[field] === "string" && row[field].trim(), `source account fixture has no ${field}`);
    }
    return {
      accountId: row.account_id.trim(),
      accessToken: row.access_token.trim(),
      refreshToken: row.refresh_token.trim(),
    };
  } finally {
    await client.end();
  }
}

function captureServerOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-SERVER_LOG_LIMIT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => redact(output);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(2_000)]);
}

async function request(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? HTTP_TIMEOUT_MS);
  const headers = new Headers(options.headers);
  if (options.portalToken) headers.set("authorization", `Bearer ${options.portalToken}`);
  if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${snippet(body)}`);
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl, child, readServerOutput) {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`server exited before becoming healthy\n${readServerOutput()}`);
    }
    try {
      const { body } = await request(baseUrl, "/health", { timeoutMs: 2_000 });
      if (isRecord(body) && body.ok === true) return body;
      lastError = new Error(`unhealthy response: ${snippet(body)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`server did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${readServerOutput()}`);
}

function responsesPayload(text) {
  return {
    model: MODEL,
    instructions: "Answer briefly.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    ],
    tools: [],
    store: false,
    stream: true,
  };
}

function codexClientHeaders(sessionId = crypto.randomUUID()) {
  return {
    originator: "codex-tui",
    version: CLIENT_VERSION,
    "user-agent": `codex-tui/${CLIENT_VERSION}`,
    "session-id": sessionId,
    "thread-id": sessionId,
    "x-client-request-id": sessionId,
    "x-codex-window-id": `${sessionId}:0`,
    "x-codex-turn-metadata": JSON.stringify({
      installation_id: crypto.randomUUID(),
      session_id: sessionId,
      thread_id: sessionId,
      agent_name: "/root",
      turn_id: "",
      window_id: `${sessionId}:0`,
      window_number: 0,
      context_window_id: crypto.randomUUID(),
      request_kind: "turn",
      thread_source: "user",
    }),
  };
}

function parseSseBlock(block) {
  const eventLines = block.split(/\r?\n/);
  const event = eventLines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
  const data = eventLines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return { event, payload: JSON.parse(data) };
  } catch {
    throw new Error(`invalid SSE JSON: ${snippet(data)}`);
  }
}

async function runSse(baseUrl, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        ...codexClientHeaders(),
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(responsesPayload("Reply with a short E2E acknowledgement.")),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`POST /v1/responses returned ${response.status}: ${snippet(await response.text())}`);
    }

    const events = [];
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) events.push(parsed.payload);
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) events.push(parsed.payload);
    }

    const failure = events.find((item) => isRecord(item) && ["error", "response.failed", "response.incomplete"].includes(String(item.type)));
    if (failure) throw new Error(`upstream SSE failure: ${snippet(failure)}`);
    const completed = events.findLast((item) => isRecord(item) && item.type === "response.completed");
    assert(isRecord(completed) && isRecord(completed.response), "response.completed was not received");
    assert(isRecord(completed.response.usage), "completed response has no usage");
    const output = events
      .filter((item) => isRecord(item) && item.type === "response.output_text.delta" && typeof item.delta === "string")
      .map((item) => item.delta)
      .join("");
    assert(output.length > 0, "SSE response produced no output text");
    return completed.response;
  } finally {
    clearTimeout(timeout);
  }
}

async function runWebSocket(baseUrl, apiKey) {
  const sessionId = crypto.randomUUID();
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/v1/responses";
  return new Promise((resolve, reject) => {
    let settled = false;
    const events = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "e2e_completed");
      }
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error("WebSocket response timed out")), RESPONSE_TIMEOUT_MS);
    const socket = new WebSocket(wsUrl, {
      headers: {
        ...codexClientHeaders(sessionId),
        authorization: `Bearer ${apiKey}`,
        "openai-beta": "responses_websockets=2026-02-06",
      },
    });

    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "response.create",
        ...responsesPayload("Reply with a short WebSocket E2E acknowledgement."),
      }));
    });
    socket.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        finish(new Error(`invalid WebSocket JSON: ${snippet(raw.toString("utf8"))}`));
        return;
      }
      events.push(event);
      if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
        finish(new Error(`upstream WebSocket failure: ${snippet(event)}`));
        return;
      }
      if (event.type === "response.completed") {
        const output = events
          .filter((item) => item.type === "response.output_text.delta" && typeof item.delta === "string")
          .map((item) => item.delta)
          .join("");
        if (!isRecord(event.response?.usage)) {
          finish(new Error("completed WebSocket response has no usage"));
          return;
        }
        if (!output) {
          finish(new Error("WebSocket response produced no output text"));
          return;
        }
        finish(null, event.response);
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      response.on("end", () => finish(new Error(`WebSocket upgrade returned ${response.statusCode}: ${snippet(body)}`)));
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", (code, reason) => {
      if (!settled) finish(new Error(`WebSocket closed before completion (${code} ${snippet(reason.toString())})`));
    });
  });
}

async function pollForSettlements(baseUrl, portalToken, apiKeyId, expectedPaths) {
  const deadline = Date.now() + 20_000;
  let lastItems = [];
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ keyId: apiKeyId, limit: "50" });
    const { body } = await request(baseUrl, `/api/request-logs?${params}`, { portalToken });
    lastItems = Array.isArray(body?.items) ? body.items : [];
    const remaining = [...expectedPaths.entries()].some(([path, count]) => lastItems.filter((item) => item?.path === path).length < count);
    if (!remaining) return lastItems;
    await delay(400);
  }
  throw new Error(`settlements were not persisted; received paths: ${snippet(lastItems.map((item) => item?.path))}`);
}

function assertMinimalLogs(items) {
  const allowedTokenKeys = new Set([
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "input_text_tokens",
    "input_image_tokens",
    "cached_text_input_tokens",
    "cached_image_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "output_text_tokens",
    "output_image_tokens",
    "total_tokens",
    "tool_usage",
  ]);
  for (const item of items) {
    assert(item?.statusCode >= 200 && item.statusCode < 300, `request log contains failed status: ${snippet(item)}`);
    assert(item?.isFinal === true, `request log is not final: ${snippet(item)}`);
    assert(typeof item?.cost === "number" && item.cost >= 0, `request log cost is invalid: ${snippet(item)}`);
    if (!isRecord(item?.tokensInfo)) continue;
    assert(!("attribution" in item.tokensInfo), "request log leaked usage.attribution");
    for (const key of Object.keys(item.tokensInfo)) {
      assert(allowedTokenKeys.has(key), `request log contains unexpected token field ${key}`);
    }
  }
}

async function main() {
  const databaseUrl = requiredEnv("E2E_DATABASE_URL", "DATABASE_URL");
  const sourceIdToken = requiredEnv("E2E_SOURCE_ID_TOKEN");
  const sourceFixtureEmail = process.env.E2E_SOURCE_FIXTURE_EMAIL?.trim() ?? "";
  let sourceCredentials = sourceFixtureEmail
    ? null
    : {
        accountId: requiredEnv("E2E_SOURCE_ACCOUNT_ID"),
        accessToken: requiredEnv("E2E_SOURCE_ACCESS_TOKEN"),
        refreshToken: requiredEnv("E2E_SOURCE_REFRESH_TOKEN"),
      };
  const sourceEmail = process.env.E2E_SOURCE_EMAIL?.trim() || `e2e-${Date.now()}@example.test`;
  const port = integerEnv("E2E_PORT", 53142);
  const skipImages = booleanEnv("E2E_SKIP_IMAGES");
  const keepSchema = booleanEnv("E2E_KEEP_SCHEMA");
  const schema = `cocodex_e2e_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const isolatedDatabaseUrl = databaseUrlWithSchema(databaseUrl, schema);
  const adminUsername = "e2e_admin";
  const adminPassword = crypto.randomBytes(24).toString("base64url");
  const adminJwtSecret = crypto.randomBytes(48).toString("base64url");
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = null;
  let readServerOutput = () => "";
  let cleanupPromise = null;

  secrets.add(sourceEmail);
  if (sourceFixtureEmail) secrets.add(sourceFixtureEmail);
  secrets.add(adminPassword);
  secrets.add(adminJwtSecret);
  secrets.add(isolatedDatabaseUrl);

  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await stopServer(child);
      if (!keepSchema) await dropSchema(databaseUrl, schema);
    })();
    return cleanupPromise;
  };
  const stopOnSignal = (exitCode) => {
    void cleanup()
      .catch(() => {})
      .finally(() => process.exit(exitCode));
  };
  process.once("SIGINT", () => stopOnSignal(130));
  process.once("SIGTERM", () => stopOnSignal(143));

  const startedAt = Date.now();
  try {
    if (sourceFixtureEmail) {
      sourceCredentials = await withStep("读取上游账号测试夹具", () =>
        loadSourceAccountFixture(databaseUrl, sourceFixtureEmail),
      );
      secrets.add(sourceCredentials.accountId);
      secrets.add(sourceCredentials.accessToken);
      secrets.add(sourceCredentials.refreshToken);
    }
    assert(sourceCredentials, "source account credentials are unavailable");
    await withStep("创建隔离数据库 schema", () => createSchema(databaseUrl, schema));
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: isolatedDatabaseUrl,
        HOST: "127.0.0.1",
        PORT: String(port),
        ADMIN_USERNAME: adminUsername,
        ADMIN_PASSWORD: adminPassword,
        ADMIN_JWT_SECRET: adminJwtSecret,
        CODEX_CLIENT_VERSION: CLIENT_VERSION,
        RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS: "250",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    readServerOutput = captureServerOutput(child);

    await withStep("启动本地服务并通过健康检查", () => waitForHealth(baseUrl, child, readServerOutput));

    const login = await withStep("登录管理接口", async () => {
      const { body } = await request(baseUrl, "/api/auth/login", {
        method: "POST",
        body: { username: adminUsername, password: adminPassword },
      });
      const token = body?.accessToken?.token;
      assert(typeof token === "string" && token.length > 0, `login response has no access token: ${snippet(body)}`);
      secrets.add(token);
      return token;
    });

    await withStep("新增并激活上游账号", async () => {
      const { body } = await request(baseUrl, "/api/openai-accounts", {
        method: "POST",
        portalToken: login,
        body: {
          email: sourceEmail,
          accountId: sourceCredentials.accountId,
          idToken: sourceIdToken,
          accessToken: sourceCredentials.accessToken,
          refreshToken: sourceCredentials.refreshToken,
        },
      });
      assert(body?.status === "active", `first account was not activated: ${snippet(body)}`);
      for (const key of ["idToken", "accessToken", "refreshToken", "id_token", "access_token", "refresh_token"]) {
        assert(!(key in body), `account response leaked ${key}`);
      }
    });

    await withStep(`账号连通性默认使用 ${MODEL}`, async () => {
      const { body } = await request(baseUrl, `/api/openai-accounts/${encodeURIComponent(sourceEmail)}/test`, {
        method: "POST",
        portalToken: login,
        body: {},
        timeoutMs: RESPONSE_TIMEOUT_MS,
      });
      assert(body?.ok === true && body?.upstreamStatus === 200, `account connectivity failed: ${snippet(body)}`);
      assert(body?.result !== null && body?.result !== undefined, `account connectivity returned no result: ${snippet(body)}`);
    });

    await withStep("读取账号用量与额度估算", async () => {
      const { body } = await request(baseUrl, `/api/openai-accounts/${encodeURIComponent(sourceEmail)}/usage`, {
        portalToken: login,
        timeoutMs: RESPONSE_TIMEOUT_MS,
      });
      assert(body?.ok === true, `account usage failed: ${snippet(body)}`);
      assert(typeof body?.planType === "string", `account usage has no plan type: ${snippet(body)}`);
      assert(Array.isArray(body?.daily), `account usage has no daily series: ${snippet(body)}`);
      assert(isRecord(body?.weeklyEstimate), `account usage has no weekly estimate status: ${snippet(body)}`);
    });

    const apiKeyRecord = await withStep("创建本地 API Key", async () => {
      const { body } = await request(baseUrl, "/api/api-keys", {
        method: "POST",
        portalToken: login,
        body: { name: "e2e" },
      });
      assert(typeof body?.item?.id === "string", `API key response has no id: ${snippet(body)}`);
      assert(typeof body?.item?.apiKey === "string", `API key response has no key: ${snippet(body)}`);
      secrets.add(body.item.apiKey);
      return body.item;
    });

    await withStep("读取实时模型列表", async () => {
      const { body } = await request(baseUrl, "/v1/models", { apiKey: apiKeyRecord.apiKey });
      assert(body?.object === "list" && Array.isArray(body?.data), `invalid models response: ${snippet(body)}`);
      assert(body.data.some((item) => item?.id === MODEL), `${MODEL} is missing from the model list`);
    });

    await withStep("调用 Responses SSE", () => runSse(baseUrl, apiKeyRecord.apiKey));
    await withStep("调用 Responses WebSocket", () => runWebSocket(baseUrl, apiKeyRecord.apiKey));

    const expectedPaths = new Map([["/v1/responses", 2]]);
    if (!skipImages) {
      const generatedImage = await withStep("调用 Images generations", async () => {
        const { body } = await request(baseUrl, "/v1/images/generations", {
          method: "POST",
          apiKey: apiKeyRecord.apiKey,
          headers: codexClientHeaders(),
          body: {
            model: IMAGE_MODEL,
            prompt: "A tiny solid blue square, no text",
            background: "auto",
            quality: "auto",
            size: "auto",
          },
          timeoutMs: IMAGE_TIMEOUT_MS,
        });
        const image = body?.data?.[0]?.b64_json;
        assert(typeof image === "string" && image.length > 0, `image generation returned no image: ${snippet(body)}`);
        return image;
      });
      await withStep("调用 Images edits", async () => {
        const { body } = await request(baseUrl, "/v1/images/edits", {
          method: "POST",
          apiKey: apiKeyRecord.apiKey,
          headers: codexClientHeaders(),
          body: {
            model: IMAGE_MODEL,
            prompt: "Change the square to green, no text",
            images: [{ image_url: `data:image/png;base64,${generatedImage}` }],
            background: "auto",
            quality: "auto",
            size: "auto",
          },
          timeoutMs: IMAGE_TIMEOUT_MS,
        });
        const image = body?.data?.[0]?.b64_json;
        assert(typeof image === "string" && image.length > 0, `image edit returned no image: ${snippet(body)}`);
      });
      expectedPaths.set("/v1/images/generations", 1);
      expectedPaths.set("/v1/images/edits", 1);
    }

    const logs = await withStep("等待异步结算并查询请求日志", () => pollForSettlements(baseUrl, login, apiKeyRecord.id, expectedPaths));
    await withStep("验证日志最小化与计费字段", async () => assertMinimalLogs(logs));

    await withStep("验证 API Key 已原子累计用量", async () => {
      const { body } = await request(baseUrl, "/api/api-keys", { portalToken: login });
      const item = body?.items?.find((candidate) => candidate?.id === apiKeyRecord.id);
      assert(item && typeof item.used === "number" && item.used > 0, `API key usage was not settled: ${snippet(body)}`);
    });

    await withStep("查询小时聚合", async () => {
      const { body } = await request(baseUrl, "/api/request-logs/hourly?lookbackHours=1&maxModels=12", { portalToken: login });
      assert(Array.isArray(body?.models) && Array.isArray(body?.points), `invalid hourly response: ${snippet(body)}`);
      const requests = body.points.reduce((total, point) => total + Object.values(point?.values ?? {}).reduce((sum, value) => sum + Number(value?.requests ?? 0), 0), 0);
      const expectedCount = [...expectedPaths.values()].reduce((sum, count) => sum + count, 0);
      assert(requests >= expectedCount, `hourly rollup contains ${requests} requests, expected at least ${expectedCount}`);
    });

    console.log(`\nE2E 通过，共耗时 ${Math.round((Date.now() - startedAt) / 1000)}s${skipImages ? "（已跳过图片接口）" : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const serverOutput = readServerOutput().trim();
    console.error(`\nE2E 失败：${redact(message)}`);
    if (serverOutput) console.error(`\n服务端最近输出：\n${serverOutput}`);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => {
      console.error(`清理 E2E 资源失败：${redact(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 1;
    });
    if (keepSchema) console.log(`保留测试 schema：${schema}`);
  }
}

await main();
