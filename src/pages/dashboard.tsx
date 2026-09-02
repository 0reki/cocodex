import {
  ChevronsLeftRightEllipsis,
  CircleDollarSign,
  Coins,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useCallback } from "react";

import { ErrorState, LoadingState } from "@/components/ui";
import { useResource } from "@/hooks/use-resource";
import { useAuth } from "@/lib/auth";
import {
  formatCompact,
  formatNumber,
  formatRate,
  formatUsd,
} from "@/lib/format";
import type { HourlyStatsResponse } from "@/types/api";

const chartModule = import("@/ui/components/model-hourly-tokens-chart");
const ModelHourlyTokensChart = lazy(async () => ({
  default: (await chartModule).ModelHourlyTokensChart,
}));

export function DashboardPage() {
  const { api } = useAuth();
  const load = useCallback(
    () =>
      api<HourlyStatsResponse>(
        "/api/request-logs/hourly?lookbackHours=720&maxModels=6",
      ),
    [api],
  );
  const { data, error, loading, reload } = useResource(load);

  const totals = data?.points.reduce(
    (sum, point) => {
      Object.values(point.values).forEach((value) => {
        sum.requests += value.requests;
        sum.tokens += value.tokens;
        sum.cost += value.cost;
      });
      return sum;
    },
    { requests: 0, tokens: 0, cost: 0 },
  ) ?? { requests: 0, tokens: 0, cost: 0 };

  const metrics = [
    {
      label: "请求数",
      value: formatNumber(totals.requests),
      icon: ChevronsLeftRightEllipsis,
      tone: "text-slate-600",
      hover: "hover:bg-muted/20",
    },
    {
      label: "Tokens",
      value: formatCompact(totals.tokens),
      icon: Coins,
      tone: "text-cyan-700 dark:text-cyan-400",
      hover: "hover:bg-cyan-50/40 dark:hover:bg-cyan-950/25",
    },
    {
      label: "费用",
      value: formatUsd(totals.cost),
      icon: CircleDollarSign,
      tone: "text-lime-700 dark:text-lime-400",
      hover: "hover:bg-lime-50/40 dark:hover:bg-lime-950/25",
    },
    {
      label: "RPM / TPM",
      value: `${formatRate(data?.rpm5m)} / ${formatCompact(data?.tpm5m)}`,
      icon: Zap,
      tone: "text-violet-700 dark:text-violet-400",
      hover: "hover:bg-violet-50/40 dark:hover:bg-violet-950/25",
    },
  ];

  return (
    <main className="flex w-full flex-col gap-5 px-3 py-3 sm:gap-6 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">仪表盘</h1>
      </section>

      {error && !data ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : null}
      {loading && !data ? <LoadingState label="正在读取统计" /> : null}

      {data ? (
        <>
          <section className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <div
                  key={metric.label}
                  className={`group rounded-xl border bg-background p-5 transition-colors ${metric.hover}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {metric.label}
                    </div>
                    <Icon className={`size-4 ${metric.tone}`} />
                  </div>
                  <div
                    className={`mt-3 text-3xl font-bold tracking-tight ${metric.tone}`}
                  >
                    {metric.value}
                  </div>
                </div>
              );
            })}
          </section>

          <Suspense fallback={null}>
            <ModelHourlyTokensChart
              models={data.models}
              points={data.points}
              locale="zh-CN"
              labels={{
                title: "模型统计",
                selectMetric: "选择指标",
                selectTimeRange: "选择时间范围",
                tokens: "Tokens",
                cost: "费用",
                requests: "请求数",
                last24h: "最近 24 小时",
                last7d: "最近 7 天",
                last30d: "最近 30 天",
              }}
            />
          </Suspense>
        </>
      ) : null}
    </main>
  );
}
