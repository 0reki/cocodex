import {
  ensureDatabaseSchema,
  getServiceStatusOverview,
  type ServiceStatusSampleRecord,
} from "@workspace/database";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@workspace/ui/components/hover-card";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";
import { getServerTranslator } from "@/lib/i18n/i18n";

export const revalidate = 60;

function getSampleColorClass(
  sample: ServiceStatusSampleRecord | null,
  isModelLatency: boolean,
) {
  if (!sample) return "bg-muted";
  if (!isModelLatency) {
    return sample.statusCode === 200 ? "bg-emerald-500/80" : "bg-rose-500/85";
  }
  if (sample.statusCode !== 200) return "bg-rose-500/85";
  if (typeof sample.latencyMs === "number" && sample.latencyMs > 5000) {
    return "bg-amber-500/85";
  }
  return "bg-emerald-500/80";
}

export default async function StatusPage() {
  const { t } = await getServerTranslator();
  await ensureDatabaseSchema();
  const overview = await getServiceStatusOverview({
    limitPerMonitor: 100,
    enabledOnly: true,
  });
  const systemMonitors = overview.monitors.filter((m) =>
    m.slug.startsWith("sys-"),
  );
  const modelMonitors = overview.monitors.filter((m) =>
    m.slug.startsWith("model-"),
  );
  const renderGroups = [
    {
      key: "system",
      title: t("status.systemFunctions"),
      monitors: systemMonitors,
    },
    { key: "model", title: t("status.modelLatency"), monitors: modelMonitors },
  ].filter((group) => group.monitors.length > 0);

  function getUptimeLevel(uptimePercent: number): "good" | "warn" | "bad" {
    if (uptimePercent > 95) return "good";
    if (uptimePercent > 20) return "warn";
    return "bad";
  }

  function getMonitorLabel(slug: string, fallback: string): string {
    switch (slug) {
      case "sys-db-connection":
        return t("status.sys.db");
      case "sys-db-self-check":
        return t("status.sys.integrity");
      case "sys-signup-queue":
        return t("status.sys.queue");
      case "sys-billing-sanity":
        return t("status.sys.billing");
      case "sys-auth-config":
        return t("status.sys.auth");
      default:
        return fallback;
    }
  }

  return (
    <main className="flex w-full flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section className="space-y-1.5">
        <h1 className="text-2xl font-bold">{t("page.status")}</h1>
      </section>

      {overview.monitors.length === 0 ? (
        <section className="rounded-xl border px-6 py-10 text-sm text-muted-foreground">
          {t("status.noMonitors")}
        </section>
      ) : (
        <div className="space-y-4">
          {renderGroups.map((group) => (
            <section key={group.key} className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
                <h3 className="text-sm font-semibold sm:text-base">
                  {group.title}
                </h3>
                <span className="text-sm text-muted-foreground">
                  {group.monitors.length}{" "}
                  {group.key === "model"
                    ? t("status.models")
                    : t("status.components")}
                </span>
              </div>
              <div className="space-y-2">
                {group.monitors.map((monitor) => {
                  const isModelLatency = group.key === "model";
                  const latestWindow = monitor.samples.slice(0, 100).reverse();
                  const bars = Array.from(
                    { length: 100 },
                    (_, index) => latestWindow[index] ?? null,
                  );
                  const uptimeLevel = getUptimeLevel(monitor.uptimePercent);
                  return (
                    <div key={monitor.id} className="px-1 py-3 sm:px-2">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          {uptimeLevel === "good" ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                          ) : uptimeLevel === "warn" ? (
                            <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 shrink-0 text-rose-500" />
                          )}
                          <p className="truncate text-sm leading-normal sm:text-base">
                            {getMonitorLabel(monitor.slug, monitor.name)}
                          </p>
                        </div>
                        <div className="whitespace-nowrap text-[11px] text-muted-foreground sm:text-sm">
                          {monitor.uptimePercent.toFixed(2)}%{" "}
                          <span className="hidden sm:inline">
                            {t("status.uptime")}
                          </span>
                        </div>
                      </div>

                      <div className="grid w-full gap-0.5 [grid-template-columns:repeat(50,minmax(0,1fr))] sm:gap-1 xl:[grid-template-columns:repeat(100,minmax(0,1fr))]">
                        {bars.map((sample, index) => (
                          <HoverCard
                            key={`${monitor.id}-bar-${index}`}
                            openDelay={80}
                            closeDelay={30}
                          >
                            <HoverCardTrigger asChild>
                              <span
                                className={cn(
                                  "h-4 min-w-0 rounded-[2px] transition-transform duration-150 ease-out hover:brightness-90 hover:scale-110 sm:h-5 sm:rounded-[3px]",
                                  getSampleColorClass(sample, isModelLatency),
                                )}
                              />
                            </HoverCardTrigger>
                            <HoverCardContent className="w-52">
                              <div className="space-y-1.5">
                                <p className="text-xs text-muted-foreground">
                                  {sample
                                    ? new Date(
                                        sample.checkedAt,
                                      ).toLocaleString()
                                    : t("status.noDataPoint")}
                                </p>
                                <div className="text-sm">
                                  <span className="text-muted-foreground">
                                    {t("common.status")}:{" "}
                                  </span>
                                  {sample
                                    ? sample.statusCode === 200
                                      ? `200 ${t("status.ok")}`
                                      : `${t("status.error")} ${sample.statusCode ?? "-"}`
                                    : "-"}
                                </div>
                                <div className="text-sm">
                                  <span className="text-muted-foreground">
                                    {t("status.latestLatency")}:{" "}
                                  </span>
                                  {sample?.latencyMs == null
                                    ? "-"
                                    : `${sample.latencyMs}ms`}
                                </div>
                              </div>
                            </HoverCardContent>
                          </HoverCard>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
