import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  disableOpenAIAccountsByEmails,
  ensureDatabaseSchema,
  getSystemSettings,
  listOpenAIAccountsPage,
} from "@workspace/database";
import { getWhamUsage } from "@workspace/openai-api";

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

function normalizeLocalDbSslMode() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const sslMode = (process.env.PG_SSL_MODE ?? "").toLowerCase();
  if (sslMode !== "require") return;

  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!isLocal) return;
    process.env.PG_SSL_MODE = "disable";
    console.warn(
      "[invalid-check] PG_SSL_MODE=require with local DATABASE_URL; forcing disable for this script.",
    );
  } catch {
    // Ignore invalid URL, downstream code will raise a clearer error.
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args.set(key, "true");
      continue;
    }
    args.set(key, value);
    i += 1;
  }
  return args;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

function parseStatusList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function isHttp401Error(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /\bHTTP\s+401\b/i.test(message);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.get("help") === "true") {
    console.log("Usage: tsx scripts/export-invalid-openai-accounts.ts [options]");
    console.log("");
    console.log("Options:");
    console.log(
      "  --status <status>      Single status filter (deprecated, use --statuses)",
    );
    console.log(
      "  --statuses <list>      Comma-separated statuses (default: active,cooling down)",
    );
    console.log("  --page-size <n>        Page size when reading DB (default: 100)");
    console.log("  --concurrency <n>      Concurrent checks (default: 20)");
    console.log("  --limit <n>            Stop after checking N accounts");
    console.log(
      "  --progress-every <n>   Print progress every N checked accounts (default: 20)",
    );
    console.log(
      "  --progress-interval-sec <n>  Print heartbeat progress every N seconds (default: 5)",
    );
    console.log("  --verbose-401          Print each 401 invalid account in real time");
    return;
  }

  loadEnv();
  normalizeLocalDbSslMode();

  const legacyStatus = args.get("status")?.trim() || "";
  const statusesArg = parseStatusList(args.get("statuses"));
  const statusFilters =
    statusesArg.length > 0
      ? statusesArg
      : legacyStatus
        ? [legacyStatus]
        : ["active", "cooling down"];
  const pageSize = parsePositiveInt(args.get("page-size"), 100);
  const concurrency = Math.min(parsePositiveInt(args.get("concurrency"), 20), 100);
  const limitRaw = args.get("limit");
  const limit = limitRaw ? parsePositiveInt(limitRaw, 0) : 0;
  const progressEvery = parsePositiveInt(args.get("progress-every"), 20);
  const progressIntervalSec = parsePositiveInt(
    args.get("progress-interval-sec"),
    5,
  );
  const verbose401 = args.get("verbose-401") === "true";
  const defaultUserAgent =
    process.env.OPENAI_API_USER_AGENT?.trim() || "node/22.14.0";

  await ensureDatabaseSchema();
  const settings = await getSystemSettings();
  const userAgent = settings?.openaiApiUserAgent?.trim() || defaultUserAgent;

  let page = 1;
  let checked = 0;
  let skipped = 0;
  let unauthorized = 0;
  let failed = 0;
  let disabled = 0;
  let matchedTotal = 0;
  const startedAt = Date.now();
  const invalidEmails = new Set<string>();

  function printProgress(reason: string) {
    const scanned = checked + skipped;
    const effectiveTotal =
      limit > 0 && matchedTotal > 0 ? Math.min(matchedTotal, limit) : matchedTotal;
    const doneRatio = effectiveTotal > 0 ? scanned / effectiveTotal : 0;
    const elapsedMs = Date.now() - startedAt;
    const speed = elapsedMs > 0 ? scanned / (elapsedMs / 1000) : 0;
    const etaSeconds =
      effectiveTotal > 0 && speed > 0
        ? Math.max(0, Math.ceil((effectiveTotal - scanned) / speed))
        : 0;
    const etaText =
      effectiveTotal > 0 && scanned < effectiveTotal
        ? ` eta=${formatDurationMs(etaSeconds * 1000)}`
        : "";
    const percentText =
      effectiveTotal > 0 ? ` progress=${(doneRatio * 100).toFixed(1)}%` : "";
    console.log(
      `[invalid-check] ${reason} checked=${checked} skipped=${skipped} 401=${unauthorized} failed=${failed} disabled=${disabled}${percentText} speed=${speed.toFixed(2)}/s${etaText}`,
    );
  }

  const progressTimer = setInterval(() => {
    printProgress("heartbeat");
  }, progressIntervalSec * 1000);
  progressTimer.unref?.();

  try {
    console.log(`[invalid-check] statuses=${statusFilters.join(", ")}`);
    let totalTarget = 0;

    for (const statusFilter of statusFilters) {
      page = 1;
      let statusTotal = 0;

      while (true) {
        const pageData = await listOpenAIAccountsPage(page, pageSize, {
          status: statusFilter,
        });
        if (page === 1) {
          statusTotal = pageData.total;
          totalTarget += statusTotal;
        }
        matchedTotal = totalTarget;
        if (pageData.items.length === 0) break;
        console.log(
          `[invalid-check] status=${statusFilter} page=${pageData.page} size=${pageData.items.length} total=${pageData.total}`,
        );

        let cursor = 0;
        async function worker() {
          while (cursor < pageData.items.length) {
            const index = cursor;
            cursor += 1;
            const account = pageData.items[index];
            if (!account) continue;

            if (limit > 0 && checked >= limit) return;

            const accessToken = account.accessToken?.trim() ?? "";
            const accountId = account.accountId?.trim() ?? "";
            if (!accessToken || !accountId) {
              skipped += 1;
              continue;
            }

            checked += 1;
            try {
              await getWhamUsage({
                accessToken,
                accountId,
                userAgent,
              });
            } catch (error) {
              const message = formatError(error);
              if (isHttp401Error(error)) {
                unauthorized += 1;
                invalidEmails.add(account.email);
                if (verbose401) {
                  console.log(`[invalid-check] 401 ${account.email} ${message}`);
                }
              } else {
                failed += 1;
              }
            }

            if (checked % progressEvery === 0) {
              printProgress("progress");
            }
          }
        }

        const workers = Array.from({ length: concurrency }, () => worker());
        await Promise.all(workers);
        printProgress(`status-${statusFilter}-page-${pageData.page}-done`);

        if (limit > 0 && checked >= limit) break;
        if (pageData.page * pageData.pageSize >= pageData.total) break;
        page += 1;
      }

      if (limit > 0 && checked >= limit) break;
    }
  } finally {
    clearInterval(progressTimer);
  }

  if (invalidEmails.size > 0) {
    disabled = await disableOpenAIAccountsByEmails([
      ...invalidEmails,
    ]);
  }

  printProgress("done");
  console.log(`[invalid-check] checked=${checked}`);
  console.log(`[invalid-check] skipped(no token/accountId)=${skipped}`);
  console.log(`[invalid-check] unauthorized(401)=${unauthorized}`);
  console.log(`[invalid-check] failed(non-401)=${failed}`);
  console.log(`[invalid-check] disabled=${disabled}`);
}

main().catch((error) => {
  console.error(
    `[invalid-check] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
