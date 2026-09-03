import { Gauge, PackagePlus, RefreshCw, type LucideIcon } from "lucide-react";
import { useCallback } from "react";

import {
  ErrorState,
  LoadingState,
  PageHeader,
  Tooltip,
} from "@/components/ui";
import { useResource } from "@/hooks/use-resource";
import { useAuth } from "@/lib/auth";
import type {
  MyUsageResponse,
  PortalUser,
  QuotaWindow,
  UserQuotaPool,
} from "@/types/api";
import { Button } from "@/ui/components/button";

const userColors = ["#2563eb", "#f97316", "#16a34a", "#a855f7"];

function formatPercent(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)}%`
    : "—";
}

function formatResetAt(window: QuotaWindow | null) {
  if (!window) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(window.resetAt * 1000));
}

function QuotaRow({
  title,
  pool,
  users,
  icon: Icon,
}: {
  title: string;
  pool: UserQuotaPool;
  users: PortalUser[];
  icon: LucideIcon;
}) {
  const allocationByUser = new Map(
    pool.members.map((member) => [member.ownerUserId, member]),
  );
  const segments = users
    .map((user, index) => ({
      user,
      color: userColors[index % userColors.length],
      percent: allocationByUser.get(user.id)?.allocatedPercent ?? 0,
    }))
    .filter((segment) => segment.percent > 0);
  const totalAllocated = segments.reduce(
    (total, segment) => total + segment.percent,
    0,
  );

  return (
    <section className="grid gap-4 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">{title}</h2>
        </div>
        {pool.weeklyWindow ? (
          <div className="text-sm text-muted-foreground">
            总使用 {formatPercent(pool.weeklyWindow.usedPercent)} · 将于{" "}
            {formatResetAt(pool.weeklyWindow)} 重置
          </div>
        ) : null}
      </div>

      {pool.available && pool.weeklyWindow ? (
        <>
          <div>
            <div className="relative flex h-10 rounded-lg bg-muted">
              {[25, 50, 75].map((position) => (
                <span
                  key={position}
                  className="pointer-events-none absolute inset-y-0 z-10 border-l border-background/80"
                  style={{ left: `${position}%` }}
                />
              ))}
              {segments.map((segment, index) => (
                <span
                  key={segment.user.id}
                  className={`h-full min-w-0 transition-[width] ${
                    index === 0 ? "rounded-l-lg" : ""
                  } ${
                    index === segments.length - 1 && totalAllocated >= 100
                      ? "rounded-r-lg"
                      : ""
                  }`}
                  style={{
                    backgroundColor: segment.color,
                    width: `${Math.min(100, segment.percent)}%`,
                  }}
                >
                  <Tooltip
                    content={`${segment.user.username}: ${formatPercent(segment.percent)}`}
                    side="top"
                    className="h-full w-full min-w-0"
                  >
                    <button
                      type="button"
                      className="flex h-full w-full min-w-0 items-center justify-center overflow-hidden text-xs font-medium text-white"
                      aria-label={`${segment.user.username}: ${formatPercent(segment.percent)}`}
                    >
                      {segment.percent >= 6
                        ? formatPercent(segment.percent)
                        : null}
                    </button>
                  </Tooltip>
                </span>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>0%</span>
              <span>25%</span>
              <span>50%</span>
              <span>75%</span>
              <span>100%</span>
            </div>
          </div>

        </>
      ) : (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          当前上游账号未返回该额度池
        </div>
      )}
    </section>
  );
}

export function MyUsagePage() {
  const { api } = useAuth();
  const load = useCallback(
    (signal: AbortSignal) =>
      api<MyUsageResponse>("/api/my-usage", { signal }),
    [api],
  );
  const { data, error, loading, reload } = useResource(load);

  return (
    <main className="flex w-full flex-col gap-5 px-3 py-3 sm:gap-6 sm:px-4 sm:py-4 lg:px-5">
      <PageHeader
        title="额度信息"
        actions={
          <Button
            variant="outline"
            type="button"
            disabled={loading}
            onClick={() => void reload()}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
        }
      />

      {error && !data ? (
        <ErrorState message={error} retry={() => void reload()} />
      ) : null}
      {loading && !data ? <LoadingState label="正在读取实时额度" /> : null}

      {data ? (
        <>
          {error ? <ErrorState message={error} retry={() => void reload()} /> : null}
          <div className="divide-y rounded-xl border bg-background p-5">
            <QuotaRow
              title="标准"
              pool={data.pools.standard}
              users={data.users}
              icon={Gauge}
            />
            <QuotaRow
              title="Spark"
              pool={data.pools.spark}
              users={data.users}
              icon={PackagePlus}
            />
          </div>
        </>
      ) : null}
    </main>
  );
}
