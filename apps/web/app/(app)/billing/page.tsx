import {
  ensureDatabaseSchema,
  getPortalUserBillingSnapshot,
} from "@workspace/database";
import { Badge } from "@workspace/ui/components/badge";
import { PageSizeForm } from "@/components/common/page-size-form";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";
import Link from "next/link";

type SearchParams = Record<string, string | string[] | undefined>;

function parsePositiveInt(
  value: string | string[] | undefined,
  fallback: number,
) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function buildBillingHref(page: number, pageSize: number) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  return `/billing?${params.toString()}`;
}

function formatAmount(value: number) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(used: number, cap: number) {
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / cap) * 100)));
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getShortHash(value: string) {
  if (!value.trim()) return "--------";
  let hash = 0;
  for (const char of value) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function getAddonStatusVariant(status: string) {
  if (status === "active") return "secondary" as const;
  if (status === "expired") return "outline" as const;
  return "destructive" as const;
}

function getAddonStatusClassName(status: string) {
  if (status === "active") {
    return "border-green-200 bg-green-50 text-green-700 hover:bg-green-50";
  }
  return "";
}

function Meter({
  label,
  used,
  total,
}: {
  label: string;
  used: number;
  total: number;
}) {
  const percent = formatPercent(used, total);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {formatAmount(used)} / {formatAmount(total)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground">{percent}%</div>
    </div>
  );
}

function CompactMeter({
  label,
  used,
  total,
}: {
  label: string;
  used: number;
  total: number;
}) {
  const percent = formatPercent(used, total);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">
          {formatAmount(used)} / {formatAmount(total)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAuth("/billing");
  const { t } = await getServerTranslator();
  const query = await searchParams;
  const page = parsePositiveInt(query.page, 1);
  const pageSize = Math.min(60, parsePositiveInt(query.pageSize, 12));
  await ensureDatabaseSchema();
  const billing = await getPortalUserBillingSnapshot(session.sub);

  const hasAddOns = billing.addOnItems.length > 0;
  const total = billing.addOnItems.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const normalizedOffset = (normalizedPage - 1) * pageSize;
  const pagedAddOnItems = billing.addOnItems.slice(
    normalizedOffset,
    normalizedOffset + pageSize,
  );
  const prevPage = Math.max(1, normalizedPage - 1);
  const nextPage = Math.min(totalPages, normalizedPage + 1);
  const hasPrev = normalizedPage > 1;
  const hasNext = normalizedPage < totalPages;

  return (
    <main className="flex w-full flex-col gap-8 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">{t("page.billing")}</h1>
      </section>

      <section>
        <div className="mb-4">
          <h2 className="text-xl font-semibold">{t("billing.usage")}</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <article className="rounded-[28px] border p-6">
            <Meter
              label={t("billing.dailyUsed")}
              used={billing.addOns.dailyUsed}
              total={billing.addOns.dailyQuota}
            />
          </article>
          <article className="rounded-[28px] border p-6">
            <Meter
              label={t("billing.weeklyUsed")}
              used={billing.addOns.weeklyUsed}
              total={billing.addOns.weeklyCap}
            />
          </article>
          <article className="rounded-[28px] border p-6">
            <Meter
              label={t("billing.monthlyUsed")}
              used={billing.addOns.monthlyUsed}
              total={billing.addOns.monthlyCap}
            />
          </article>
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">
            {t("billing.addOnsSection")}
          </h2>
        </div>
        {hasAddOns ? (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {pagedAddOnItems.map((item) => (
                <article key={item.id} className="rounded-2xl border p-4">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-semibold">
                        #{getShortHash(item.sourceAccountEmail)}
                      </div>
                      <Badge
                        variant={getAddonStatusVariant(item.status)}
                        className={getAddonStatusClassName(item.status)}
                      >
                        {item.status === "active"
                          ? t("status.active")
                          : item.status === "expired"
                            ? t("billing.addOnExpired")
                            : t("status.suspended")}
                      </Badge>
                    </div>

                    <div className="space-y-2 text-sm">
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground">
                          {t("billing.addOnUsage")}
                        </div>
                        <div className="space-y-2">
                          <CompactMeter
                            label={t("billing.day")}
                            used={item.dailyUsed}
                            total={item.dailyQuota}
                          />
                          <CompactMeter
                            label={t("billing.week")}
                            used={item.weeklyUsed}
                            total={item.weeklyCap}
                          />
                          <CompactMeter
                            label={t("billing.month")}
                            used={item.monthlyUsed}
                            total={item.monthlyCap}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-muted-foreground">
                          {t("billing.addOnExpiresAt")}
                        </div>
                        <div className="text-right text-sm font-medium">
                          {formatDateTime(
                            item.expiresAt ?? item.sourceAccountPlanExpiresAt,
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <section className="flex flex-wrap items-center justify-end gap-2">
              <Link
                href={buildBillingHref(1, pageSize)}
                className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
                  hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-50"
                }`}
              >
                {t("common.first")}
              </Link>
              <Link
                href={buildBillingHref(prevPage, pageSize)}
                className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
                  hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-50"
                }`}
              >
                {t("common.prev")}
              </Link>
              <span className="min-w-24 text-center text-sm text-muted-foreground">
                {t("common.page")}: {normalizedPage}/{totalPages}
              </span>
              <PageSizeForm
                action="/billing"
                pageSize={pageSize}
                hiddenInputs={[{ name: "page", value: "1" }]}
                options={[6, 12, 24, 36, 60]}
              />
              <Link
                href={buildBillingHref(nextPage, pageSize)}
                className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
                  hasNext ? "hover:bg-muted" : "pointer-events-none opacity-50"
                }`}
              >
                {t("common.next")}
              </Link>
              <Link
                href={buildBillingHref(totalPages, pageSize)}
                className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
                  hasNext ? "hover:bg-muted" : "pointer-events-none opacity-50"
                }`}
              >
                {t("common.last")}
              </Link>
            </section>
          </>
        ) : (
          <article className="rounded-[28px] border border-dashed p-6">
            <div className="flex min-h-40 items-center justify-center text-center">
              <div className="space-y-2">
                <div className="text-lg font-semibold">
                  {t("billing.noAddOns")}
                </div>
                <div className="text-sm text-muted-foreground">
                  {t("billing.noAddOnsHint")}
                </div>
              </div>
            </div>
          </article>
        )}
      </section>
    </main>
  );
}
