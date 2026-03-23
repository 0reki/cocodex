"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
  ChartContainer,
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

type KeyQueryPoint = {
  hour: string;
  requests: number;
  tokens: number;
  cost: number;
};

type Metric = "requests" | "tokens" | "cost";
type TimeRange = "24h" | "7d" | "30d";

const rangeToHours: Record<TimeRange, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

const chartConfig = {
  value: { label: "Value", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function KeyQueryStatsChart({ points }: { points: KeyQueryPoint[] }) {
  const [metric, setMetric] = React.useState<Metric>("tokens");
  const [timeRange, setTimeRange] = React.useState<TimeRange>("7d");

  const filtered = React.useMemo(() => {
    if (points.length === 0) return [];
    const referenceDate = new Date(points[points.length - 1]?.hour ?? Date.now());
    const startDate = new Date(referenceDate);
    startDate.setHours(startDate.getHours() - rangeToHours[timeRange] + 1);
    return points
      .filter((item) => new Date(item.hour) >= startDate)
      .map((item) => ({
        hour: item.hour,
        value: metric === "tokens" ? item.tokens : metric === "cost" ? item.cost : item.requests,
      }));
  }, [points, metric, timeRange]);

  return (
    <section className="rounded-xl border bg-background">
      <div className="flex items-center gap-2 border-b px-5 py-4">
        <h2 className="flex-1 text-base font-semibold tracking-tight">Stats Trend</h2>
        <Select value={metric} onValueChange={(value) => setMetric(value as Metric)}>
          <SelectTrigger className="w-32" aria-label="Select metric">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="tokens">Tokens</SelectItem>
            <SelectItem value="cost">Cost</SelectItem>
            <SelectItem value="requests">Requests</SelectItem>
          </SelectContent>
        </Select>
        <Select value={timeRange} onValueChange={(value) => setTimeRange(value as TimeRange)}>
          <SelectTrigger className="w-28" aria-label="Select range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value="24h">24h</SelectItem>
            <SelectItem value="7d">7d</SelectItem>
            <SelectItem value="30d">30d</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="px-2 py-4 sm:px-4">
        <ChartContainer config={chartConfig} className="h-72 w-full">
          <AreaChart data={filtered}>
            <defs>
              <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="hour"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(value: string | number) =>
                new Date(String(value)).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                })
              }
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  indicator="dot"
                  labelFormatter={(value) =>
                    new Date(String(value)).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  }
                />
              }
            />
            <Area
              dataKey="value"
              type="monotone"
              stroke="var(--color-value)"
              fill="url(#fillValue)"
              strokeWidth={1.8}
            />
          </AreaChart>
        </ChartContainer>
      </div>
    </section>
  );
}
