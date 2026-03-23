"use client";

import * as React from "react";
import { ModelHourlyTokensChart } from "@workspace/ui/components/model-hourly-tokens-chart";
import { useLocale } from "@/components/providers/locale-provider";

type ModelHourlyTokenPoint = {
  hour: string;
  values: Record<
    string,
    {
      tokens: number;
      cost: number;
      requests: number;
    }
  >;
};

export function ModelHourlyTokensChartClient({
  models,
  points,
}: {
  models: string[];
  points: ModelHourlyTokenPoint[];
}) {
  const { t, locale } = useLocale();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <ModelHourlyTokensChart
      models={models}
      points={points}
      locale={locale}
      labels={{
        title: t("chart.modelStatistics"),
        selectMetric: t("chart.metric"),
        selectTimeRange: t("chart.timeRange"),
        emptyHint: t("chart.emptyHint"),
        tokens: t("chart.tokens"),
        cost: t("chart.cost"),
        requests: t("chart.requests"),
        last24h: t("chart.last24h"),
        last7d: t("chart.last7d"),
        last30d: t("chart.last30d"),
      }}
    />
  );
}
