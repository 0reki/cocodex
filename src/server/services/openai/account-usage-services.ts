const CREDITS_PER_USD = 25;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MAX_ANALYTICS_DAYS = 90;
const MAX_USAGE_SNAPSHOTS = 100;

type UsageSnapshot = {
  resetAt: number;
  usedPercent: number;
  observedCredits: number;
};

type UsageWindow = {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number | null;
  resetAt: number;
  startsAt: string;
  resetsAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function rounded(value: number) {
  return Number(value.toFixed(8));
}

function creditsToUsd(credits: number) {
  return rounded(credits / CREDITS_PER_USD);
}

function isoDate(timestampMs: number) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function isoTimestamp(timestampSeconds: number) {
  return new Date(timestampSeconds * 1000).toISOString();
}

function normalizeWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null;
  const limitWindowSeconds = Math.trunc(
    finiteNumber(value.limit_window_seconds),
  );
  const resetAt = Math.trunc(finiteNumber(value.reset_at));
  if (limitWindowSeconds <= 0 || resetAt <= 0) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, finiteNumber(value.used_percent))),
    limitWindowSeconds,
    resetAfterSeconds:
      value.reset_after_seconds === null ||
      value.reset_after_seconds === undefined
        ? null
        : Math.max(0, Math.trunc(finiteNumber(value.reset_after_seconds))),
    resetAt,
    startsAt: isoTimestamp(resetAt - limitWindowSeconds),
    resetsAt: isoTimestamp(resetAt),
  };
}

function getRateLimitWindows(usage: Record<string, unknown>) {
  const rateLimit = isRecord(usage.rate_limit) ? usage.rate_limit : null;
  return {
    allowed: typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : null,
    limitReached:
      typeof rateLimit?.limit_reached === "boolean"
        ? rateLimit.limit_reached
        : null,
    primaryWindow: normalizeWindow(rateLimit?.primary_window),
    secondaryWindow: normalizeWindow(rateLimit?.secondary_window),
  };
}

function normalizeUsageCounters(value: unknown) {
  const source = isRecord(value) ? value : {};
  const credits = optionalNonNegativeNumber(source.credits);
  const integer = (input: unknown) => {
    const parsed = optionalNonNegativeNumber(input);
    return parsed === null ? null : Math.trunc(parsed);
  };
  return {
    users: integer(source.users),
    threads: integer(source.threads),
    turns: integer(source.turns),
    credits,
    usd: credits === null ? null : creditsToUsd(credits),
    uncachedTextInputTokens: integer(source.uncached_text_input_tokens),
    cachedTextInputTokens: integer(source.cached_text_input_tokens),
    textOutputTokens: integer(source.text_output_tokens),
    textTotalTokens: integer(source.text_total_tokens),
  };
}

function normalizeDailyRows(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.data)) return [];
  return payload.data
    .filter(isRecord)
    .map((item) => {
      const date = typeof item.date === "string" ? item.date : "";
      const clients = Array.isArray(item.clients)
        ? item.clients.filter(isRecord).map((client) => ({
            clientId:
              typeof client.client_id === "string" ? client.client_id : "",
            ...normalizeUsageCounters(client),
          }))
        : [];
      const models = Array.isArray(item.models)
        ? item.models.filter(isRecord).map((model) => ({
            model: typeof model.model === "string" ? model.model : "",
            ...normalizeUsageCounters(model),
          }))
        : [];
      return {
        date,
        totals: normalizeUsageCounters(item.totals),
        clients,
        models,
      };
    })
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeCredits(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    hasCredits:
      typeof value.has_credits === "boolean" ? value.has_credits : null,
    unlimited: typeof value.unlimited === "boolean" ? value.unlimited : null,
    overageLimitReached:
      typeof value.overage_limit_reached === "boolean"
        ? value.overage_limit_reached
        : null,
    balance:
      typeof value.balance === "string" || typeof value.balance === "number"
        ? String(value.balance)
        : null,
  };
}

function normalizeSpendControl(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    reached: typeof value.reached === "boolean" ? value.reached : null,
    individualLimit: value.individual_limit ?? null,
  };
}

function normalizeResetCredits(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    availableCount: optionalNonNegativeNumber(value.available_count),
    applicableAvailableCount: optionalNonNegativeNumber(
      value.applicable_available_count,
    ),
  };
}

function selectLongestWindow(windows: ReturnType<typeof getRateLimitWindows>) {
  return [windows.primaryWindow, windows.secondaryWindow]
    .filter((window): window is UsageWindow => window !== null)
    .sort(
      (left, right) => right.limitWindowSeconds - left.limitWindowSeconds,
    )[0] ?? null;
}

export function resolveUsageAnalyticsDateRange(
  usage: Record<string, unknown>,
  capturedAtMs = Date.now(),
) {
  const longestWindow = selectLongestWindow(getRateLimitWindows(usage));
  const earliestMs = capturedAtMs - MAX_ANALYTICS_DAYS * 24 * 60 * 60 * 1000;
  const windowStartMs = longestWindow
    ? (longestWindow.resetAt - longestWindow.limitWindowSeconds) * 1000
    : capturedAtMs;
  return {
    startDate: isoDate(Math.max(earliestMs, windowStartMs)),
    endDate: isoDate(capturedAtMs),
  };
}

export function createAccountUsageSummaryService() {
  const snapshots = new Map<string, UsageSnapshot>();

  function rememberSnapshot(accountId: string, snapshot: UsageSnapshot) {
    if (!snapshots.has(accountId) && snapshots.size >= MAX_USAGE_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value;
      if (typeof oldest === "string") snapshots.delete(oldest);
    }
    snapshots.set(accountId, snapshot);
  }

  function summarize(args: {
    accountId: string;
    usage: Record<string, unknown>;
    dailyUsage: Record<string, unknown>;
    capturedAtMs?: number;
  }) {
    const capturedAtMs = args.capturedAtMs ?? Date.now();
    const rateLimit = getRateLimitWindows(args.usage);
    const weeklyWindow = [rateLimit.primaryWindow, rateLimit.secondaryWindow]
      .find((window) => window?.limitWindowSeconds === WEEK_SECONDS) ?? null;
    const daily = normalizeDailyRows(args.dailyUsage);
    const todayDate = isoDate(capturedAtMs);
    const observedCredits = weeklyWindow
      ? rounded(
          daily
            .filter((item) => item.date >= weeklyWindow.startsAt.slice(0, 10))
            .reduce((sum, item) => sum + (item.totals.credits ?? 0), 0),
        )
      : 0;
    const previous = snapshots.get(args.accountId) ?? null;
    let method: "snapshot_delta" | "window_ratio" | null = null;
    let estimatedTotalCredits: number | null = null;

    if (weeklyWindow && weeklyWindow.usedPercent > 0 && observedCredits > 0) {
      const deltaPercent = previous
        ? weeklyWindow.usedPercent - previous.usedPercent
        : 0;
      const deltaCredits = previous
        ? observedCredits - previous.observedCredits
        : 0;
      if (
        previous?.resetAt === weeklyWindow.resetAt &&
        deltaPercent > 0 &&
        deltaCredits > 0
      ) {
        method = "snapshot_delta";
        estimatedTotalCredits = rounded((deltaCredits * 100) / deltaPercent);
      } else {
        method = "window_ratio";
        estimatedTotalCredits = rounded(
          (observedCredits * 100) / weeklyWindow.usedPercent,
        );
      }
    }

    if (weeklyWindow) {
      const currentSnapshot = {
        resetAt: weeklyWindow.resetAt,
        usedPercent: weeklyWindow.usedPercent,
        observedCredits,
      };
      if (
        !previous ||
        previous.resetAt !== currentSnapshot.resetAt ||
        currentSnapshot.usedPercent >= previous.usedPercent
      ) {
        rememberSnapshot(args.accountId, currentSnapshot);
      }
    }

    const estimatedTotalUsd =
      estimatedTotalCredits === null
        ? null
        : creditsToUsd(estimatedTotalCredits);
    const estimatedRemainingUsd =
      estimatedTotalUsd === null || !weeklyWindow
        ? null
        : rounded(
            estimatedTotalUsd * (1 - weeklyWindow.usedPercent / 100),
          );
    const totalCredits = rounded(
      daily.reduce((sum, item) => sum + (item.totals.credits ?? 0), 0),
    );

    return {
      capturedAt: new Date(capturedAtMs).toISOString(),
      planType:
        typeof args.usage.plan_type === "string"
          ? args.usage.plan_type
          : null,
      rateLimit,
      credits: normalizeCredits(args.usage.credits),
      spendControl: normalizeSpendControl(args.usage.spend_control),
      rateLimitResetCredits: normalizeResetCredits(
        args.usage.rate_limit_reset_credits,
      ),
      daily,
      today: daily.find((item) => item.date === todayDate) ?? null,
      totals: {
        credits: totalCredits,
        usd: creditsToUsd(totalCredits),
      },
      weeklyEstimate: {
        available: estimatedTotalUsd !== null,
        reason: weeklyWindow
          ? weeklyWindow.usedPercent <= 0
            ? "usage_percent_is_zero"
            : observedCredits <= 0
              ? "daily_usage_is_zero"
              : null
          : "weekly_window_unavailable",
        method,
        approximate: true,
        window: weeklyWindow,
        observedCredits,
        observedUsd: creditsToUsd(observedCredits),
        estimatedTotalCredits,
        estimatedTotalUsd,
        estimatedRemainingUsd,
      },
    };
  }

  return { summarize };
}
