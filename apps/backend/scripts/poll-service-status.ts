import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureDatabaseSchema,
  getSystemSettings,
  insertServiceStatusSample,
  listOpenAIAccountsForModelCache,
  listServiceStatusMonitors,
  listSignupProxies,
  listTeamAccountsForModelCache,
  query,
  runDatabaseSelfCheck,
  upsertServiceStatusMonitor,
} from "@workspace/database";
import { postCodexResponses } from "@workspace/openai-api";

type DatabaseModule = {
  ensureDatabaseSchema: () => Promise<void>;
  listServiceStatusMonitors: (input?: { enabledOnly?: boolean }) => Promise<
    Array<{
      id: string;
      slug: string;
      name: string;
      endpoint: string;
      method: string;
      enabled: boolean;
      intervalSeconds: number;
      timeoutMs: number;
    }>
  >;
  upsertServiceStatusMonitor: (input: {
    slug: string;
    name: string;
    endpoint: string;
    method?: string;
    enabled?: boolean;
    intervalSeconds?: number;
    timeoutMs?: number;
  }) => Promise<unknown>;
  insertServiceStatusSample: (input: {
    monitorId: string;
    checkedAt?: string | Date;
    ok: boolean;
    statusCode?: number | null;
    latencyMs?: number | null;
    errorMessage?: string | null;
    retainPerMonitor?: number;
  }) => Promise<unknown>;
  getSystemSettings: () => Promise<{
    openaiModels: Array<Record<string, unknown>> | null;
    openaiClientVersion: string | null;
  } | null>;
  listSignupProxies: (enabledOnly?: boolean) => Promise<
    Array<{
      id: string;
      proxyUrl: string;
      enabled: boolean;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  listOpenAIAccountsForModelCache: (limit?: number) => Promise<
    Array<{
      id: string;
      email: string;
      accountId: string | null;
      userId: string | null;
      accessToken: string | null;
    }>
  >;
  listTeamAccountsForModelCache: (limit?: number) => Promise<
    Array<{
      id: string;
      email: string;
      accountId: string | null;
      userId: string | null;
      accessToken: string | null;
    }>
  >;
  runDatabaseSelfCheck: () => Promise<{
    ok: boolean;
    issues: Array<{
      level: "warning" | "error";
      message: string;
      count?: number;
    }>;
  }>;
  query: <T = { [key: string]: unknown }>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

type MonitorSeed = {
  slug: string;
  name: string;
  endpoint: string;
  method?: string;
  enabled?: boolean;
  intervalSeconds?: number;
  timeoutMs?: number;
};

type ProbeResult = {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  errorMessage: string | null;
};

type OpenAiApiProbe = (options: {
  accessToken: string;
  accountId?: string;
  version: string;
  sessionId: string;
  payload?: Record<string, unknown> | null;
  proxyUrl?: string;
  userAgent?: string;
  signal?: AbortSignal;
}) => Promise<Response>;

function loadEnvFile(filePath: string, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (overwrite || !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadEnv() {
  const cwd = process.cwd();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const backendDir = path.resolve(here, "..");
  const rootDir = path.resolve(backendDir, "..", "..");

  loadEnvFile(path.join(rootDir, ".env.local"), false);
  loadEnvFile(path.join(rootDir, ".env"), false);
  loadEnvFile(path.join(backendDir, ".env.local"), true);
  loadEnvFile(path.join(backendDir, ".env"), true);
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
}

function parseMonitorSeeds(): MonitorSeed[] {
  const raw = process.env.SERVICE_STATUS_MONITORS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is MonitorSeed => {
        return (
          !!item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).slug === "string" &&
          typeof (item as Record<string, unknown>).name === "string" &&
          typeof (item as Record<string, unknown>).endpoint === "string"
        );
      })
      .map((item) => ({
        slug: item.slug.trim(),
        name: item.name.trim(),
        endpoint: item.endpoint.trim(),
        method: item.method?.trim(),
        enabled: item.enabled ?? true,
        intervalSeconds: item.intervalSeconds,
        timeoutMs: item.timeoutMs,
      }))
      .filter((item) => item.slug && item.name && item.endpoint);
  } catch (error) {
    console.warn(
      `[status-poll] failed to parse SERVICE_STATUS_MONITORS: ${error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function parseModelListFromSettings(
  settings: { openaiModels: Array<Record<string, unknown>> | null } | null,
): string[] {
  const models = settings?.openaiModels;
  if (!Array.isArray(models)) return [];
  return models
    .map((item) => {
      if (typeof item.slug === "string") return item.slug.trim();
      if (typeof item.id === "string") return item.id.trim();
      return "";
    })
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

async function seedMonitors(database: DatabaseModule) {
  const seeds: MonitorSeed[] = [
    {
      slug: "sys-db-connection",
      name: "Database",
      endpoint: "internal://db/connection",
      method: "INTERNAL_DB_CONNECTION",
      enabled: true,
      intervalSeconds: 300,
      timeoutMs: 10_000,
    },
    {
      slug: "sys-db-self-check",
      name: "Integrity",
      endpoint: "internal://db/self-check",
      method: "INTERNAL_DB_SELF_CHECK",
      enabled: true,
      intervalSeconds: 300,
      timeoutMs: 10_000,
    },
    {
      slug: "sys-signup-queue",
      name: "Queue",
      endpoint: "internal://signup/queue",
      method: "INTERNAL_SIGNUP_QUEUE",
      enabled: true,
      intervalSeconds: 300,
      timeoutMs: 10_000,
    },
    {
      slug: "sys-billing-sanity",
      name: "Billing",
      endpoint: "internal://billing/sanity",
      method: "INTERNAL_BILLING_SANITY",
      enabled: true,
      intervalSeconds: 300,
      timeoutMs: 10_000,
    },
    {
      slug: "sys-auth-config",
      name: "Auth",
      endpoint: "internal://auth/config",
      method: "INTERNAL_AUTH_CONFIG",
      enabled: true,
      intervalSeconds: 300,
      timeoutMs: 10_000,
    },
  ];
  const customSeeds = parseMonitorSeeds();
  seeds.push(...customSeeds);
  for (const seed of seeds) {
    await database.upsertServiceStatusMonitor(seed);
  }

  const settings = await database.getSystemSettings().catch(() => null);
  const settingsModels = parseModelListFromSettings(settings);
  const models = Array.from(new Set(settingsModels));
  if (models.length === 0) return;

  for (const model of models) {
    await database.upsertServiceStatusMonitor({
      slug: `model-${model.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase()}`,
      name: model,
      endpoint: model,
      method: "MODEL_LATENCY",
      enabled: true,
      intervalSeconds: 300,
      timeoutMs: 20_000,
    });
  }
}

async function runInternalProbe(
  database: DatabaseModule,
  method: string,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  if (method === "INTERNAL_DB_CONNECTION") {
    try {
      await database.query("SELECT 1 AS ok");
      return {
        ok: true,
        statusCode: 200,
        latencyMs: Date.now() - startedAt,
        errorMessage: null,
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        latencyMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (method === "INTERNAL_DB_SELF_CHECK") {
    try {
      const report = await database.runDatabaseSelfCheck();
      const errors = report.issues.filter((issue) => issue.level === "error");
      return {
        ok: report.ok,
        statusCode: report.ok ? 200 : 500,
        latencyMs: Date.now() - startedAt,
        errorMessage:
          errors.length === 0
            ? null
            : errors
              .slice(0, 3)
              .map((item) =>
                item.count != null
                  ? `${item.message} (${item.count})`
                  : item.message,
              )
              .join("; "),
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        latencyMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (method === "INTERNAL_SIGNUP_QUEUE") {
    try {
      const res = await database.query<{ stuck_count: string }>(
        `
          SELECT COUNT(*)::text AS stuck_count
          FROM signup_tasks
          WHERE status IN ('running', 'stopping')
            AND updated_at < now() - interval '15 minutes'
        `,
      );
      const stuckCount = Number(res.rows[0]?.stuck_count ?? "0");
      return {
        ok: stuckCount === 0,
        statusCode: stuckCount === 0 ? 200 : 500,
        latencyMs: Date.now() - startedAt,
        errorMessage: stuckCount === 0 ? null : `stuck_tasks=${stuckCount}`,
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        latencyMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (method === "INTERNAL_BILLING_SANITY") {
    try {
      const res = await database.query<{
        negative_balance_count: string;
      }>(
        `
          SELECT
            (
              SELECT COUNT(*)::text
              FROM portal_users
              WHERE balance < 0
            ) AS negative_balance_count
        `,
      );
      const negativeBalanceCount = Number(
        res.rows[0]?.negative_balance_count ?? "0",
      );
      return {
        ok: negativeBalanceCount === 0,
        statusCode: negativeBalanceCount === 0 ? 200 : 500,
        latencyMs: Date.now() - startedAt,
        errorMessage:
          negativeBalanceCount === 0
            ? null
            : `negative_balance=${negativeBalanceCount}`,
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        latencyMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (method === "INTERNAL_AUTH_CONFIG") {
    const missing: string[] = [];
    if (!process.env.ADMIN_JWT_SECRET?.trim()) missing.push("ADMIN_JWT_SECRET");
    if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");
    return {
      ok: missing.length === 0,
      statusCode: missing.length === 0 ? 200 : 500,
      latencyMs: Date.now() - startedAt,
      errorMessage:
        missing.length === 0 ? null : `missing_env=${missing.join(",")}`,
    };
  }

  return {
    ok: false,
    statusCode: 500,
    latencyMs: Date.now() - startedAt,
    errorMessage: `unknown_internal_probe_method=${method}`,
  };
}

function parseHttpStatusFromError(errorMessage: string | null): number | null {
  if (!errorMessage) return null;
  const match = errorMessage.match(/\bHTTP\s+(\d{3})\b/i);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runModelLatencyProbe(input: {
  monitorModel: string;
  monitorTimeoutMs: number;
  openaiApi: OpenAiApiProbe;
  accounts: Array<{
    id: string;
    email: string;
    accountId: string | null;
    userId: string | null;
    accessToken: string | null;
  }>;
  accountPoolLabel: string;
  proxyPool: string[];
  maxAttempts: number;
  clientVersion: string;
}): Promise<ProbeResult> {
  const startedAt = Date.now();
  const usableAccounts = input.accounts.filter(
    (item) =>
      typeof item.accessToken === "string" &&
      item.accessToken.trim().length > 0 &&
      typeof (item.accountId ?? item.userId) === "string" &&
      (item.accountId ?? item.userId)?.trim().length > 0,
  );
  if (usableAccounts.length === 0) {
    return {
      ok: false,
      statusCode: 503,
      latencyMs: Date.now() - startedAt,
      errorMessage: `No usable ${input.accountPoolLabel} upstream account`,
    };
  }

  const attemptCount = Math.max(
    1,
    Math.min(input.maxAttempts, usableAccounts.length, 8),
  );
  const baseIndex = Math.floor(Math.random() * usableAccounts.length);
  let lastErrorMessage: string | null = null;
  let lastStatusCode: number | null = null;

  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    const candidate =
      usableAccounts[(baseIndex + attempt) % usableAccounts.length] ?? null;
    if (!candidate?.accessToken) continue;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.monitorTimeoutMs,
    );
    try {
      const accountId = (candidate.accountId ?? candidate.userId ?? "").trim();
      if (!accountId) {
        clearTimeout(timeout);
        lastErrorMessage = "OpenAI upstream account is missing accountId";
        lastStatusCode = 503;
        continue;
      }
      const response = await input.openaiApi({
        accessToken: candidate.accessToken,
        accountId,
        version: input.clientVersion,
        sessionId: globalThis.crypto.randomUUID(),
        proxyUrl:
          input.proxyPool.length > 0
            ? (input.proxyPool[
              Math.floor(Math.random() * input.proxyPool.length)
            ] ?? undefined)
            : undefined,
        payload: {
          model: input.monitorModel,
          input: "ping",
          max_output_tokens: 16,
          stream: true,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // This probe only measures upstream response latency; drain-free.
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancellation errors from already closed streams.
      }
      return {
        ok: true,
        statusCode: response.status || 200,
        latencyMs: Date.now() - startedAt,
        errorMessage: null,
      };
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      lastErrorMessage = message.slice(0, 500);
      lastStatusCode = parseHttpStatusFromError(lastErrorMessage);
    }
  }

  return {
    ok: false,
    statusCode: lastStatusCode ?? 503,
    latencyMs: Date.now() - startedAt,
    errorMessage: lastErrorMessage ?? "Model latency probe failed",
  };
}

async function runPollRound(database: DatabaseModule) {
  const startedAt = Date.now();
  const monitors = await database.listServiceStatusMonitors({
    enabledOnly: true,
  });
  if (monitors.length === 0) {
    console.log("[status-poll] no enabled monitors");
    return;
  }

  const now = new Date();
  const settings = await database.getSystemSettings().catch(() => null);
  const clientVersion =
    settings?.openaiClientVersion?.trim() ||
    process.env.OPENAI_CLIENT_VERSION?.trim() ||
    "prod";
  const retryAttempts = Math.max(
    1,
    Number.parseInt(process.env.STATUS_MODEL_PROBE_RETRY_ATTEMPTS ?? "3", 10) ||
    3,
  );
  const proxyPool = (await database.listSignupProxies(true)).map(
    (item) => item.proxyUrl,
  );
  const [openaiUpstreamAccounts, teamUpstreamAccounts] = await Promise.all([
    database.listOpenAIAccountsForModelCache(200),
    database.listTeamAccountsForModelCache(200),
  ]);

  await Promise.allSettled(
    monitors.map(async (monitor) => {
      if (monitor.method.startsWith("INTERNAL_")) {
        const result = await runInternalProbe(database, monitor.method);
        await database.insertServiceStatusSample({
          monitorId: monitor.id,
          checkedAt: now,
          ok: result.ok,
          statusCode: result.statusCode,
          latencyMs: result.latencyMs,
          errorMessage: result.errorMessage,
          retainPerMonitor: 100,
        });
        return;
      }

      if (monitor.method === "MODEL_LATENCY") {
        const probe = await runModelLatencyProbe({
          monitorModel: monitor.endpoint,
          monitorTimeoutMs: monitor.timeoutMs,
          openaiApi: postCodexResponses,
          accounts: openaiUpstreamAccounts,
          accountPoolLabel: "openai",
          proxyPool,
          maxAttempts: retryAttempts,
          clientVersion,
        });

        await database.insertServiceStatusSample({
          monitorId: monitor.id,
          checkedAt: now,
          ok: probe.ok,
          statusCode: probe.statusCode,
          latencyMs: probe.latencyMs,
          errorMessage: probe.errorMessage,
          retainPerMonitor: 100,
        });
        return;
      }

      const requestStartedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), monitor.timeoutMs);
      let ok = false;
      let statusCode: number | null = null;
      let latencyMs: number | null = null;
      let errorMessage: string | null = null;
      try {
        const headers: Record<string, string> = {
          "user-agent": "CoCodex/StatusPoller",
        };
        const response = await fetch(monitor.endpoint, {
          method: monitor.method || "GET",
          redirect: "follow",
          signal: controller.signal,
          headers,
        });
        statusCode = response.status;
        latencyMs = Date.now() - requestStartedAt;
        ok = response.ok;
        if (!ok) errorMessage = `HTTP ${response.status}`;
      } catch (error) {
        latencyMs = Date.now() - requestStartedAt;
        ok = false;
        errorMessage =
          error instanceof Error ? error.message.slice(0, 500) : String(error);
      } finally {
        clearTimeout(timer);
      }

      await database.insertServiceStatusSample({
        monitorId: monitor.id,
        checkedAt: now,
        ok,
        statusCode,
        latencyMs,
        errorMessage,
        retainPerMonitor: 100,
      });
    }),
  );

  console.log(
    `[status-poll] polled ${monitors.length} checks (sys+model) in ${Date.now() - startedAt}ms`,
  );
}

async function main() {
  loadEnv();
  const database: DatabaseModule = {
    ensureDatabaseSchema,
    listServiceStatusMonitors,
    upsertServiceStatusMonitor,
    insertServiceStatusSample,
    getSystemSettings,
    listSignupProxies,
    listOpenAIAccountsForModelCache,
    listTeamAccountsForModelCache,
    runDatabaseSelfCheck,
    query,
  };

  await database.ensureDatabaseSchema();
  await seedMonitors(database);

  const once = process.argv.includes("--once");
  const intervalSeconds = Math.max(
    60,
    Number.parseInt(
      process.env.SERVICE_STATUS_POLL_INTERVAL_SECONDS ?? "300",
      10,
    ) || 300,
  );
  const intervalMs = intervalSeconds * 1000;

  if (once) {
    await runPollRound(database);
    return;
  }

  await runPollRound(database);
  setInterval(() => {
    void runPollRound(database).catch((error) => {
      console.error(
        "[status-poll] round failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, intervalMs);

  console.log(
    `[status-poll] running with interval=${intervalSeconds}s and retention=100/monitor`,
  );
}

main().catch((error) => {
  console.error(
    "[status-poll] fatal:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
