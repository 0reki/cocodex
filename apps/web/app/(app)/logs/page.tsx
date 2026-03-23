import {
  listModelResponseLogsPageByOwnerUserId,
  listModelResponseLogsPage,
} from "@workspace/database";
import { RequestLogsFilters } from "@/components/logs/request-logs-filters";
import { RequestLogsTable } from "@/components/logs/request-logs-table";
import { PageSizeForm } from "@/components/common/page-size-form";
import Link from "next/link";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";

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

function getQueryValue(value: string | string[] | undefined) {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? (value[0] ?? "")
      : "";
}

function buildLogsHref(
  page: number,
  pageSize: number,
  filters: {
    keyId: string;
    modelId: string;
    requestStatus: string;
    requestDateFrom: string;
    requestDateTo: string;
  },
) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (filters.keyId) params.set("keyId", filters.keyId);
  if (filters.modelId) params.set("model", filters.modelId);
  if (filters.requestStatus) params.set("status", filters.requestStatus);
  if (filters.requestDateFrom) params.set("dateFrom", filters.requestDateFrom);
  if (filters.requestDateTo) params.set("dateTo", filters.requestDateTo);
  return `/logs?${params.toString()}`;
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAuth("/logs");
  const { t } = await getServerTranslator();

  try {
    const query = await searchParams;
    const page = parsePositiveInt(query.page, 1);
    const pageSize = Math.min(200, parsePositiveInt(query.pageSize, 50));
    const filters = {
      keyId: getQueryValue(query.keyId).trim(),
      modelId: getQueryValue(query.model).trim(),
      requestStatus: getQueryValue(query.status).trim(),
      requestDateFrom: getQueryValue(query.dateFrom || query.date).trim(),
      requestDateTo: getQueryValue(query.dateTo || query.date).trim(),
    };
    const data =
      session.role === "admin"
        ? await listModelResponseLogsPage(page, pageSize, filters)
        : await listModelResponseLogsPageByOwnerUserId(
            session.sub,
            page,
            pageSize,
            filters,
          );
    const prevPage = Math.max(1, data.page - 1);
    const nextPage = Math.min(data.totalPages, data.page + 1);
    const hasPrev = data.page > 1;
    const hasNext = data.page < data.totalPages;

    return (
      <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
        <section>
          <h1 className="text-2xl font-bold">{t("page.logs")}</h1>
        </section>
        <RequestLogsFilters
          initialKeyId={filters.keyId}
          initialModelId={filters.modelId}
          initialStatus={filters.requestStatus}
          initialDateFrom={filters.requestDateFrom}
          initialDateTo={filters.requestDateTo}
          pageSize={data.pageSize}
        />
        <RequestLogsTable rows={data.items} />
        <section className="flex flex-wrap items-center justify-end gap-2">
          <Link
            href={buildLogsHref(1, data.pageSize, filters)}
            className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
              hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-50"
            }`}
          >
            {t("common.first")}
          </Link>
          <Link
            href={buildLogsHref(prevPage, data.pageSize, filters)}
            className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
              hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-50"
            }`}
          >
            {t("common.prev")}
          </Link>
          <span className="min-w-24 text-center text-sm text-muted-foreground">
            {t("common.page")}: {data.page}/{data.totalPages}
          </span>
          <PageSizeForm
            action="/logs"
            pageSize={data.pageSize}
            hiddenInputs={[
              { name: "page", value: "1" },
              ...(filters.keyId
                ? [{ name: "keyId", value: filters.keyId }]
                : []),
              ...(filters.modelId
                ? [{ name: "model", value: filters.modelId }]
                : []),
              ...(filters.requestStatus
                ? [{ name: "status", value: filters.requestStatus }]
                : []),
              ...(filters.requestDateFrom
                ? [{ name: "dateFrom", value: filters.requestDateFrom }]
                : []),
              ...(filters.requestDateTo
                ? [{ name: "dateTo", value: filters.requestDateTo }]
                : []),
            ]}
          />
          <Link
            href={buildLogsHref(nextPage, data.pageSize, filters)}
            className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
              hasNext ? "hover:bg-muted" : "pointer-events-none opacity-50"
            }`}
          >
            {t("common.next")}
          </Link>
          <Link
            href={buildLogsHref(data.totalPages, data.pageSize, filters)}
            className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
              hasNext ? "hover:bg-muted" : "pointer-events-none opacity-50"
            }`}
          >
            {t("common.last")}
          </Link>
        </section>
      </main>
    );
  } catch (error) {
    return (
      <main className="flex w-full flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
        <h1 className="text-2xl font-bold">{t("status.failedLoadLogs")}</h1>
        <pre className="overflow-auto rounded-md border p-4 text-xs">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      </main>
    );
  }
}
