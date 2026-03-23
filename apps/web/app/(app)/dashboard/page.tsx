import { Suspense } from "react";
import {
  getPortalUserModelHourlyStatsSeries,
  getPortalUserAccountStats,
  getPortalUserUsageStats,
  getModelHourlyStatsSeries,
  getOpenAIAccountStats,
  type PortalUserUsageStats,
  type PortalUserRole,
  type PortalUserAccountStats,
} from "@workspace/database";
import {
  ChartNoAxesCombined,
  CircleCheckBig,
  Clock3,
  Coins,
  ReceiptText,
  ShieldBan,
  Sigma,
  Users,
} from "lucide-react";
import { ModelHourlyTokensChartClient } from "@/components/charts/model-hourly-tokens-chart-client";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";
import { formatTokenCompact } from "@/lib/format/number-format";

type SessionLike = { sub: string; role: PortalUserRole };

type DashboardSummaryData = {
  accountStats:
    | Awaited<ReturnType<typeof getOpenAIAccountStats>>
    | PortalUserAccountStats;
  usageStats: PortalUserUsageStats;
};

type DashboardChartData = Awaited<ReturnType<typeof getModelHourlyStatsSeries>>;

type DashboardCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const DASHBOARD_SUMMARY_CACHE_TTL_MS = 15_000;
const DASHBOARD_CHART_CACHE_TTL_MS = 60_000;
const dashboardCache =
  (
    globalThis as {
      __workspaceDashboardCache?: Map<string, DashboardCacheEntry<unknown>>;
    }
  ).__workspaceDashboardCache ??
  new Map<string, DashboardCacheEntry<unknown>>();

(
  globalThis as {
    __workspaceDashboardCache?: Map<string, DashboardCacheEntry<unknown>>;
  }
).__workspaceDashboardCache = dashboardCache;

async function getCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = dashboardCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }
  const value = await loader();
  dashboardCache.set(key, {
    expiresAt: now + ttlMs,
    value,
  });
  return value;
}

async function loadDashboardSummaryCached(
  session: SessionLike,
): Promise<DashboardSummaryData> {
  const cacheKey =
    session.role === "admin"
      ? "dashboard:admin:summary"
      : `dashboard:user:${session.sub}:summary`;

  return getCached(cacheKey, DASHBOARD_SUMMARY_CACHE_TTL_MS, async () => {
    if (session.role === "admin") {
      const accountStats = await getOpenAIAccountStats();
      return {
        accountStats,
        usageStats: {
          dailyRequestCount: accountStats.dailyRequestCount,
          totalRequestCount: accountStats.totalRequestCount,
          dailyRequestTokens: accountStats.dailyRequestTokens,
          totalTokens: accountStats.totalTokens,
          dailyRequestCost: accountStats.dailyRequestCost,
          totalCost: accountStats.totalCost,
          rpm5m: accountStats.rpm5m,
          tpm5m: accountStats.tpm5m,
        },
      };
    }

    const usageStats = await getPortalUserUsageStats(session.sub);
    const accountStats = await getPortalUserAccountStats(session.sub);
    return { accountStats, usageStats };
  });
}

async function loadDashboardChartCached(
  session: SessionLike,
): Promise<DashboardChartData> {
  const cacheKey =
    session.role === "admin"
      ? "dashboard:admin:chart"
      : `dashboard:user:${session.sub}:chart`;

  return getCached(cacheKey, DASHBOARD_CHART_CACHE_TTL_MS, async () => {
    if (session.role === "admin") {
      return getModelHourlyStatsSeries(24 * 30, 6);
    }
    return getPortalUserModelHourlyStatsSeries(session.sub, 24 * 30, 6);
  });
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "-";
}

function formatCost(value: number) {
  if (!Number.isFinite(value)) return "-";
  const truncated = Math.trunc(value * 1000) / 1000;
  return `$${truncated.toFixed(3)}`;
}

function formatRpm(value: number) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTpm(value: number) {
  if (!Number.isFinite(value)) return "-";
  return formatTokenCompact(value);
}

async function DashboardChartSection({ session }: { session: SessionLike }) {
  try {
    const modelHourlyTokens = await loadDashboardChartCached(session);
    return (
      <ModelHourlyTokensChartClient
        models={modelHourlyTokens.models}
        points={modelHourlyTokens.points}
      />
    );
  } catch {
    return (
      <section className="rounded-xl border p-5 text-sm text-muted-foreground">
        Failed to load model statistics.
      </section>
    );
  }
}

function ChartFallback({ label }: { label: string }) {
  return (
    <section className="rounded-xl border p-5 text-sm text-muted-foreground">
      {label}
    </section>
  );
}

export default async function Page() {
  const session = await requireAuth("/dashboard");
  const { t } = await getServerTranslator();

  try {
    const { accountStats, usageStats } =
      await loadDashboardSummaryCached(session);

    return (
      <main className="flex w-full flex-col gap-5 px-3 py-3 sm:gap-6 sm:px-4 sm:py-4 lg:px-5">
        <section>
          <h1 className="text-2xl font-bold">{t("page.dashboard")}</h1>
        </section>

        <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.totalAccounts")}
              </div>
              <Users className="size-4 text-slate-600" />
            </div>
            <div className="mt-3 text-4xl font-bold tracking-tight">
              {accountStats.total}
            </div>
          </div>

          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-emerald-50/40 dark:hover:bg-emerald-950/25">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.activeAccounts")}
              </div>
              <CircleCheckBig className="size-4 text-emerald-600" />
            </div>
            <div className="mt-3 text-4xl font-bold tracking-tight text-emerald-600">
              {accountStats.active}
            </div>
          </div>

          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-amber-50/40 dark:hover:bg-amber-950/25">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.coolingDownAccounts")}
              </div>
              <Clock3 className="size-4 text-amber-600" />
            </div>
            <div className="mt-3 text-4xl font-bold tracking-tight text-amber-600">
              {accountStats.coolingDown}
            </div>
          </div>

          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-red-50/40 dark:hover:bg-red-950/25">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.disabledAccounts")}
              </div>
              <ShieldBan className="size-4 text-red-600" />
            </div>
            <div className="mt-3 text-4xl font-bold tracking-tight text-red-600">
              {accountStats.disabled}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.requestsDailyTotal")}
              </div>
              <ReceiptText className="size-4 text-slate-600" />
            </div>
            <div className="mt-3 text-3xl font-bold tracking-tight">
              {formatNumber(usageStats.dailyRequestCount)} /{" "}
              {formatNumber(usageStats.totalRequestCount)}
            </div>
          </div>

          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-cyan-50/40 dark:hover:bg-cyan-950/25">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.tokensDailyTotal")}
              </div>
              <Sigma className="size-4 text-cyan-600" />
            </div>
            <div className="mt-3 text-3xl font-bold tracking-tight text-cyan-700 dark:text-cyan-400">
              {formatTokenCompact(usageStats.dailyRequestTokens)} /{" "}
              {formatTokenCompact(usageStats.totalTokens)}
            </div>
          </div>

          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-lime-50/40 dark:hover:bg-lime-950/25">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.costDailyTotal")}
              </div>
              <Coins className="size-4 text-lime-700" />
            </div>
            <div className="mt-3 text-3xl font-bold tracking-tight text-lime-700 dark:text-lime-400">
              {formatCost(usageStats.dailyRequestCost)} /{" "}
              {formatCost(usageStats.totalCost)}
            </div>
          </div>

          <div className="group rounded-xl border bg-background p-5 transition-colors hover:bg-violet-50/40 dark:hover:bg-violet-950/25">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("stats.rpmTpm5m")}
              </div>
              <ChartNoAxesCombined className="size-4 text-violet-600" />
            </div>
            <div className="mt-3 text-3xl font-bold tracking-tight text-violet-700 dark:text-violet-400">
              {formatRpm(usageStats.rpm5m)} / {formatTpm(usageStats.tpm5m)}
            </div>
          </div>
        </section>

        <Suspense fallback={<ChartFallback label={t("common.loading")} />}>
          <DashboardChartSection session={session} />
        </Suspense>
      </main>
    );
  } catch (error) {
    return (
      <main className="flex w-full flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
        <h1 className="text-2xl font-bold">{t("status.dbNotReady")}</h1>
        <pre className="overflow-auto rounded-md border p-4 text-xs">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </main>
    );
  }
}
