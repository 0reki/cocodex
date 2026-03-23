"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@workspace/ui/components/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";

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

type ModelHourlyTokensChartProps = {
  models: string[];
  points: ModelHourlyTokenPoint[];
  locale?: string;
  labels?: {
    title?: string;
    selectMetric?: string;
    selectTimeRange?: string;
    emptyHint?: string;
    tokens?: string;
    cost?: string;
    requests?: string;
    last24h?: string;
    last7d?: string;
    last30d?: string;
  };
};

const modelPalette = [
  "hsl(214 90% 56%)",
  "hsl(160 84% 40%)",
  "hsl(12 90% 56%)",
  "hsl(272 74% 58%)",
  "hsl(42 95% 52%)",
  "hsl(334 82% 58%)",
  "hsl(196 94% 50%)",
  "hsl(120 55% 45%)",
  "hsl(0 84% 60%)",
  "hsl(30 94% 53%)",
  "hsl(280 70% 60%)",
  "hsl(173 80% 36%)",
];

type TimeRange = "24h" | "7d" | "30d";
type Metric = "tokens" | "cost" | "requests";

const rangeToHours: Record<TimeRange, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

function formatTokenCompact(value: number) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

export function ModelHourlyTokensChart({
  models,
  points,
  locale = "en-US",
  labels,
}: ModelHourlyTokensChartProps) {
  const [timeRange, setTimeRange] = React.useState<TimeRange>("24h");
  const [metric, setMetric] = React.useState<Metric>("tokens");

  const modelSeries = React.useMemo(
    () =>
      models.map((model, index) => ({
        model,
        key: `m${index}`,
        color: modelPalette[index % modelPalette.length],
      })),
    [models],
  );

  const chartConfig = React.useMemo(() => {
    const config: ChartConfig = {
      tokens: { label: labels?.tokens ?? "Tokens" },
    };
    for (const item of modelSeries) {
      config[item.key] = {
        label: item.model,
        color: item.color,
      };
    }
    return config;
  }, [labels?.tokens, modelSeries]);

  const filteredRows = React.useMemo(() => {
    if (points.length === 0 || modelSeries.length === 0) return [];
    const referenceDate = new Date(
      points[points.length - 1]?.hour ?? Date.now(),
    );
    const startDate = new Date(referenceDate);
    startDate.setHours(startDate.getHours() - rangeToHours[timeRange] + 1);
    return points
      .filter((item) => new Date(item.hour) >= startDate)
      .map((item) => {
        const row: Record<string, number | string> = { hour: item.hour };
        for (const series of modelSeries) {
          const metricValues = item.values[series.model] ?? {
            tokens: 0,
            cost: 0,
            requests: 0,
          };
          const rawValue = metricValues[metric];
          row[series.key] =
            metric === "cost" ? Math.trunc(rawValue * 1000) / 1000 : rawValue;
        }
        return row;
      });
  }, [points, modelSeries, timeRange, metric]);
  const isEmpty = modelSeries.length === 0 || filteredRows.length === 0;

  return (
    <section className="rounded-xl border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-4 sm:px-5">
        <div className="grid flex-1 gap-1">
          <h2 className="text-base font-semibold tracking-tight">
            {labels?.title ?? "Model Statistics"}
          </h2>
        </div>
        <Select
          value={metric}
          onValueChange={(value) => setMetric(value as Metric)}
        >
          <SelectTrigger
            className="w-30 sm:w-32"
            aria-label={labels?.selectMetric ?? "Select metric"}
          >
            <SelectValue placeholder={labels?.tokens ?? "Tokens"} />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="tokens">{labels?.tokens ?? "Tokens"}</SelectItem>
            <SelectItem value="cost">{labels?.cost ?? "Cost"}</SelectItem>
            <SelectItem value="requests">
              {labels?.requests ?? "Requests"}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={timeRange}
          onValueChange={(value) => setTimeRange(value as TimeRange)}
        >
          <SelectTrigger
            className="w-34 sm:w-35"
            aria-label={labels?.selectTimeRange ?? "Select time range"}
          >
            <SelectValue placeholder={labels?.last24h ?? "Last 24h"} />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="24h">{labels?.last24h ?? "Last 24h"}</SelectItem>
            <SelectItem value="7d">{labels?.last7d ?? "Last 7d"}</SelectItem>
            <SelectItem value="30d">{labels?.last30d ?? "Last 30d"}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="px-2 py-4 sm:px-4">
        {isEmpty ? (
          <div className="flex h-80 w-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {labels?.emptyHint ??
              "Start your first request, then come back to view statistics."}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-80 w-full">
            <AreaChart data={filteredRows}>
              <defs>
                {modelSeries.map((series) => (
                  <linearGradient
                    key={`fill-${series.key}`}
                    id={`fill-${series.key}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="5%"
                      stopColor={`var(--color-${series.key})`}
                      stopOpacity={0.36}
                    />
                    <stop
                      offset="95%"
                      stopColor={`var(--color-${series.key})`}
                      stopOpacity={0.04}
                    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="hour"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(value: string | number) => {
                  const date = new Date(String(value));
                  return date.toLocaleDateString(locale, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                  });
                }}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    formatter={(value, name, item) => {
                      const numeric =
                        typeof value === "number" ? value : Number(value);
                      const displayValue = !Number.isFinite(numeric)
                        ? String(value)
                        : metric === "tokens"
                          ? formatTokenCompact(numeric)
                          : metric === "cost"
                            ? `$${(Math.trunc(numeric * 1000) / 1000).toFixed(3)}`
                            : numeric.toLocaleString(locale);
                      const modelName =
                        typeof name === "string" ? name : String(name ?? "");
                      const color =
                        item?.color ?? item?.payload?.fill ?? "currentColor";
                      return (
                        <div className="flex w-full items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                              style={{ backgroundColor: String(color) }}
                            />
                            <span className="text-muted-foreground">
                              {modelName}
                            </span>
                          </div>
                          <span className="font-mono font-medium tabular-nums">
                            {displayValue}
                          </span>
                        </div>
                      );
                    }}
                    labelFormatter={(value) =>
                      new Date(String(value)).toLocaleString(locale, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    }
                  />
                }
              />
              {modelSeries.map((series) => (
                <Area
                  key={series.key}
                  dataKey={series.key}
                  name={series.model}
                  type="monotone"
                  stroke={`var(--color-${series.key})`}
                  fill={`url(#fill-${series.key})`}
                  strokeWidth={1.8}
                />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </div>
    </section>
  );
}
