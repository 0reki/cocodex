import { runSingleFlow } from "../shared/flow.ts";
import { parseRunOptions } from "../shared/runtime.ts";
import type {
  SignupBatchOptions,
  SignupBatchResult,
  SignupMailProvider,
  SignupRunOptions,
  SignupRunResult,
} from "../shared/types.ts";

async function runBatch(
  options: SignupRunOptions & {
    onResult?: (result: SignupRunResult) => void | Promise<void>;
    includeResults?: boolean;
  },
): Promise<SignupBatchResult> {
  const {
    count,
    concurrency,
    proxyPool = [],
    mailProvider,
    onResult,
    includeResults = true,
  } = options;
  if (mailProvider) {
    return runBatchInProcess({
      count,
      concurrency,
      proxyPool,
      mailProvider,
      onResult,
      includeResults,
    });
  }
  throw new Error("mailProvider must be configured explicitly");
}

async function runBatchInProcess(
  options: SignupRunOptions & {
    onResult?: (result: SignupRunResult) => void | Promise<void>;
    includeResults?: boolean;
    mailProvider: SignupMailProvider;
  },
): Promise<SignupBatchResult> {
  const {
    count,
    concurrency,
    proxyPool = [],
    mailProvider,
    onResult,
    includeResults = true,
  } = options;
  const startedAt = Date.now();
  const results: SignupRunResult[] = [];
  const runDurations: number[] = [];
  let successCount = 0;
  let failedCount = 0;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= count) return;
      const runId = idx + 1;
      const start = proxyPool.length > 0 ? idx % proxyPool.length : 0;
      const orderedPool =
        proxyPool.length > 0
          ? proxyPool.slice(start).concat(proxyPool.slice(0, start))
          : [];
      const result = await runSingleFlow(
        runId,
        count,
        false,
        orderedPool[0],
        orderedPool,
        mailProvider,
      );
      if (result.ok) successCount += 1;
      else failedCount += 1;
      runDurations.push(result.durationMs);
      if (includeResults) {
        results.push(result);
      }
      if (onResult) {
        await onResult(result);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(count, concurrency)) }, () =>
      worker(),
    ),
  );

  if (includeResults) {
    results.sort((a, b) => a.runId - b.runId);
  }
  const totalDurationMs = Date.now() - startedAt;
  const avgDurationMs =
    runDurations.length === 0
      ? 0
      : Math.floor(
        runDurations.reduce((sum, ms) => sum + ms, 0) / runDurations.length,
      );

  return {
    total: count,
    successCount,
    failedCount,
    wallClockMs: totalDurationMs,
    averageRunMs: avgDurationMs,
    results: includeResults ? results : [],
  };
}

export async function runSignupFlow(
  options: {
    proxyUrl?: string | null;
    proxyPool?: string[];
    mailProvider?: SignupMailProvider;
  } = {},
): Promise<SignupRunResult> {
  return runSingleFlow(
    1,
    1,
    false,
    options.proxyUrl,
    Array.isArray(options.proxyPool) ? options.proxyPool : [],
    options.mailProvider,
  );
}

export async function runSignupBatch(
  options: SignupBatchOptions = {},
): Promise<SignupBatchResult> {
  const count = Math.max(1, Math.floor(options.count ?? 1));
  const concurrency = Math.max(
    1,
    Math.min(Math.floor(options.concurrency ?? 1), count),
  );
  return runBatch({
    count,
    concurrency,
    proxyPool: Array.isArray(options.proxyPool) ? options.proxyPool : [],
    mailProvider: options.mailProvider,
    onResult: options.onResult,
  });
}

export async function runSignupCli(argv: string[] = process.argv.slice(2)) {
  const options = parseRunOptions(argv);
  return runBatch(options);
}
