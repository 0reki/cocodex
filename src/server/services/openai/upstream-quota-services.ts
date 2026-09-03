import * as openaiApiModule from "../../../openai-api/index.ts";
import type {
  getUpstreamQuotaWindow,
  getUserUpstreamQuotaAllocation,
  listPortalUserUpstreamAssignments,
  listUpstreamQuotaMemberAllocations,
  recordUserUpstreamQuotaUsage,
  syncUpstreamQuotaWindow,
  UpstreamQuotaMemberAllocations,
  UpstreamQuotaPool,
  UserUpstreamQuotaAllocation,
} from "../../../database/index.ts";
import { formatUsdAmount, type UsdAmount } from "../../../shared/usd.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const USER_QUOTA_PERCENT = 25;

type SourceAccount = {
  id: string;
  accessToken: string;
  accountId: string;
  refreshToken: string;
  idToken: string;
};

type QuotaWindow = {
  resetAt: number;
  usedPercent: number;
  limitWindowSeconds: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWindow(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) return null;
  const limitWindowSeconds = Math.trunc(Number(value.limit_window_seconds));
  const resetAt = Math.trunc(Number(value.reset_at));
  const usedPercent = Number(value.used_percent);
  if (
    limitWindowSeconds <= 0 ||
    resetAt <= 0 ||
    !Number.isFinite(usedPercent)
  ) {
    return null;
  }
  return {
    resetAt,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    limitWindowSeconds,
  };
}

function getRateLimitForPool(
  usage: Record<string, unknown>,
  quotaPool: UpstreamQuotaPool,
) {
  if (quotaPool === "standard") {
    return isRecord(usage.rate_limit) ? usage.rate_limit : null;
  }
  const additional = Array.isArray(usage.additional_rate_limits)
    ? usage.additional_rate_limits
    : [];
  const spark = additional.find((value) => {
    if (!isRecord(value)) return false;
    const limitName =
      typeof value.limit_name === "string"
        ? value.limit_name.toLowerCase()
        : "";
    const feature =
      typeof value.metered_feature === "string"
        ? value.metered_feature.toLowerCase()
        : "";
    return limitName.includes("spark") || feature === "codex_bengalfox";
  });
  return isRecord(spark) && isRecord(spark.rate_limit)
    ? spark.rate_limit
    : null;
}

function getPoolWindows(
  usage: Record<string, unknown>,
  quotaPool: UpstreamQuotaPool,
) {
  const rateLimit = getRateLimitForPool(usage, quotaPool);
  return {
    primary: normalizeWindow(rateLimit?.primary_window),
    secondary: normalizeWindow(rateLimit?.secondary_window),
  };
}

function getWeeklyWindow(
  usage: Record<string, unknown>,
  quotaPool: UpstreamQuotaPool,
) {
  const windows = getPoolWindows(usage, quotaPool);
  const weekly = [windows.primary, windows.secondary].find(
    (window) => window?.limitWindowSeconds === WEEK_SECONDS,
  );
  if (!weekly) {
    throw new Error(`${quotaPool} weekly quota window is unavailable`);
  }
  return weekly;
}

function getQuotaPoolForModel(model: string | null): UpstreamQuotaPool {
  return model?.trim().toLowerCase().includes("spark") ? "spark" : "standard";
}

export function createUpstreamQuotaServices(deps: {
  getCodexUsageWithTokenRefresh: (input: {
    module: typeof openaiApiModule;
    account: SourceAccount;
    runtimeConfig: { userAgent: string; clientVersion: string };
    signal?: AbortSignal;
  }) => Promise<Record<string, unknown>>;
  getOpenAIApiRuntimeConfig: () => Promise<{
    userAgent: string;
    clientVersion: string;
  }>;
  getUpstreamQuotaWindow: typeof getUpstreamQuotaWindow;
  getUserUpstreamQuotaAllocation: typeof getUserUpstreamQuotaAllocation;
  listUpstreamQuotaMemberAllocations: typeof listUpstreamQuotaMemberAllocations;
  listPortalUserUpstreamAssignments: typeof listPortalUserUpstreamAssignments;
  recordUserUpstreamQuotaUsage: typeof recordUserUpstreamQuotaUsage;
  syncUpstreamQuotaWindow: typeof syncUpstreamQuotaWindow;
}) {
  const quotaState = new Map<string, UpstreamQuotaMemberAllocations>();
  const settlementTasks = new Map<string, Promise<void>>();

  const quotaKey = (sourceAccountId: string, quotaPool: UpstreamQuotaPool) =>
    `${sourceAccountId}:${quotaPool}`;

  function cacheQuotaState(snapshot: UpstreamQuotaMemberAllocations | null) {
    if (!snapshot) return;
    quotaState.set(
      quotaKey(snapshot.sourceAccountId, snapshot.quotaPool),
      snapshot,
    );
  }

  function getCachedAllocation(
    sourceAccountId: string,
    quotaPool: UpstreamQuotaPool,
    ownerUserId: string,
  ): UserUpstreamQuotaAllocation | null {
    const snapshot = quotaState.get(quotaKey(sourceAccountId, quotaPool));
    if (!snapshot) return null;
    const member = snapshot.members.find(
      (item) => item.ownerUserId === ownerUserId,
    );
    if (!member) return null;
    return {
      sourceAccountId: snapshot.sourceAccountId,
      quotaPool: snapshot.quotaPool,
      resetAt: snapshot.resetAt,
      usedPercent: snapshot.usedPercent,
      carryInPercent: snapshot.carryInPercent,
      carryInUserId: snapshot.carryInUserId,
      syncRequired: snapshot.syncRequired,
      initializedAt: snapshot.initializedAt,
      updatedAt: snapshot.updatedAt,
      userUsageAmount: member.usageAmount,
      totalUsageAmount: snapshot.totalUsageAmount,
      allocatedPercent: member.allocatedPercent,
    };
  }

  async function hydrateUpstreamQuotaCache(input?: {
    sourceAccounts?: SourceAccount[];
  }) {
    const assignments = await deps.listPortalUserUpstreamAssignments();
    const sourceAccountIds = [
      ...new Set(assignments.map((item) => item.sourceAccountId)),
    ];
    const sourceAccounts = new Map(
      (input?.sourceAccounts ?? []).map((account) => [account.id, account]),
    );
    await Promise.all(
      sourceAccountIds.map(async (sourceAccountId) => {
        const sourceAccount = sourceAccounts.get(sourceAccountId);
        if (!sourceAccount) return;
        try {
          const usage = await fetchUsage(sourceAccount);
          await Promise.all(
            (["standard", "spark"] as const).map(async (quotaPool) => {
              const windows = getPoolWindows(usage, quotaPool);
              const weeklyWindow = [windows.primary, windows.secondary].find(
                (window) => window?.limitWindowSeconds === WEEK_SECONDS,
              );
              if (!weeklyWindow) return;
              await deps.syncUpstreamQuotaWindow({
                sourceAccountId,
                quotaPool,
                ...weeklyWindow,
                carryCurrentUsageOnCreate: true,
              });
            }),
          );
        } catch (error) {
          console.warn(
            `[quota] failed to refresh startup snapshot for ${sourceAccountId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    const snapshots = await Promise.all(
      sourceAccountIds.flatMap((sourceAccountId) =>
        (["standard", "spark"] as const).map((quotaPool) =>
          deps.listUpstreamQuotaMemberAllocations({
            sourceAccountId,
            quotaPool,
          }),
        ),
      ),
    );
    quotaState.clear();
    for (const snapshot of snapshots) cacheQuotaState(snapshot);
  }

  async function fetchUsage(sourceAccount: SourceAccount) {
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    return deps.getCodexUsageWithTokenRefresh({
      module: openaiApiModule,
      account: sourceAccount,
      runtimeConfig,
      signal: AbortSignal.timeout(15_000),
    });
  }

  async function fetchWeeklyWindow(
    sourceAccount: SourceAccount,
    quotaPool: UpstreamQuotaPool,
  ) {
    return getWeeklyWindow(await fetchUsage(sourceAccount), quotaPool);
  }

  function ensureUserUpstreamQuota(input: {
    sourceAccount: SourceAccount;
    ownerUserId: string;
    model: string | null;
  }) {
    const quotaPool = getQuotaPoolForModel(input.model);
    const snapshot = quotaState.get(
      quotaKey(input.sourceAccount.id, quotaPool),
    );
    const current = Boolean(
      snapshot &&
        !snapshot.syncRequired &&
        snapshot.resetAt > Math.floor(Date.now() / 1000),
    );
    const allocation = current
      ? getCachedAllocation(
          input.sourceAccount.id,
          quotaPool,
          input.ownerUserId,
        )
      : null;
    return {
      allowed:
        allocation === null ||
        allocation.allocatedPercent < USER_QUOTA_PERCENT,
      quotaPool,
      limitPercent: USER_QUOTA_PERCENT,
      allocation,
      resetAt: snapshot?.resetAt ?? null,
    };
  }

  async function persistUserUpstreamQuota(input: {
    settlementId: string;
    sourceAccount: SourceAccount;
    ownerUserId: string;
    model: string | null;
    cost: UsdAmount | null;
    totalTokens: number | null;
  }) {
    const quotaPool = getQuotaPoolForModel(input.model);
    let upstreamWindow: QuotaWindow;
    let synchronized = true;
    try {
      upstreamWindow = await fetchWeeklyWindow(input.sourceAccount, quotaPool);
    } catch (error) {
      synchronized = false;
      const current = await deps.getUpstreamQuotaWindow({
        sourceAccountId: input.sourceAccount.id,
        quotaPool,
      });
      if (!current) throw error;
      upstreamWindow = {
        resetAt: current.resetAt,
        usedPercent: current.usedPercent,
        limitWindowSeconds: WEEK_SECONDS,
      };
    }
    const usageAmount =
      quotaPool === "spark"
        ? String(Math.max(0, Math.trunc(input.totalTokens ?? 0)))
        : formatUsdAmount(input.cost ?? 0n);
    const allocation = await deps.recordUserUpstreamQuotaUsage({
      settlementId: input.settlementId,
      sourceAccountId: input.sourceAccount.id,
      quotaPool,
      ownerUserId: input.ownerUserId,
      resetAt: upstreamWindow.resetAt,
      usedPercent: upstreamWindow.usedPercent,
      usageAmount,
      synchronized,
    });
    const snapshot = await deps.listUpstreamQuotaMemberAllocations({
      sourceAccountId: input.sourceAccount.id,
      quotaPool,
    });
    cacheQuotaState(snapshot);
    return allocation;
  }

  function settleUserUpstreamQuota(input: {
    settlementId: string;
    sourceAccount: SourceAccount;
    ownerUserId: string;
    model: string | null;
    cost: UsdAmount | null;
    totalTokens: number | null;
  }) {
    const quotaPool = getQuotaPoolForModel(input.model);
    const key = quotaKey(input.sourceAccount.id, quotaPool);
    const previous = settlementTasks.get(key) ?? Promise.resolve();
    let task: Promise<void>;
    task = previous
      .catch(() => undefined)
      .then(async () => {
        await persistUserUpstreamQuota(input);
      })
      .catch((error) => {
        console.warn(
          `[quota] failed to persist ${quotaPool} usage: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (settlementTasks.get(key) === task) settlementTasks.delete(key);
      });
    settlementTasks.set(key, task);
    const allocation = getCachedAllocation(
      input.sourceAccount.id,
      quotaPool,
      input.ownerUserId,
    );
    return {
      synchronized: false,
      allowed:
        allocation === null ||
        allocation.allocatedPercent < USER_QUOTA_PERCENT,
      quotaPool,
      limitPercent: USER_QUOTA_PERCENT,
      allocation,
    };
  }

  async function flushUpstreamQuotaSettlements() {
    while (settlementTasks.size > 0) {
      await Promise.all(settlementTasks.values());
    }
  }

  async function getUserUpstreamQuotaSummary(input: {
    sourceAccount: SourceAccount;
    ownerUserId: string;
  }) {
    const usage = await fetchUsage(input.sourceAccount);
    const pools = await Promise.all(
      (["standard", "spark"] as const).map(async (quotaPool) => {
        const windows = getPoolWindows(usage, quotaPool);
        const weeklyWindow = [windows.primary, windows.secondary].find(
          (window) => window?.limitWindowSeconds === WEEK_SECONDS,
        );
        if (!weeklyWindow) {
          return [
            quotaPool,
            {
              available: false as const,
              usageUnit: quotaPool === "spark" ? "tokens" : "weighted_usd",
              shortWindow: windows.primary,
              weeklyWindow: null,
              allocation: null,
              members: [],
            },
          ] as const;
        }
        await deps.syncUpstreamQuotaWindow({
          sourceAccountId: input.sourceAccount.id,
          quotaPool,
          ...weeklyWindow,
          carryCurrentUsageOnCreate: true,
        });
        const allocation = await deps.getUserUpstreamQuotaAllocation({
          sourceAccountId: input.sourceAccount.id,
          quotaPool,
          ownerUserId: input.ownerUserId,
        });
        const memberAllocations =
          await deps.listUpstreamQuotaMemberAllocations({
            sourceAccountId: input.sourceAccount.id,
            quotaPool,
          });
        cacheQuotaState(memberAllocations);
        return [
          quotaPool,
          {
            available: true as const,
            usageUnit: quotaPool === "spark" ? "tokens" : "weighted_usd",
            shortWindow:
              windows.primary?.limitWindowSeconds === WEEK_SECONDS
                ? null
                : windows.primary,
            weeklyWindow,
            allocation,
            members: memberAllocations?.members ?? [],
          },
        ] as const;
      }),
    );
    return {
      capturedAt: new Date().toISOString(),
      limitPercent: USER_QUOTA_PERCENT,
      pools: Object.fromEntries(pools),
    };
  }

  return {
    ensureUserUpstreamQuota,
    flushUpstreamQuotaSettlements,
    getUserUpstreamQuotaSummary,
    hydrateUpstreamQuotaCache,
    settleUserUpstreamQuota,
  };
}
