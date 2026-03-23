"use client";

import { PageSizeForm } from "@/components/common/page-size-form";
import type { LocaleKey } from "@/locales";
import type { TeamTab } from "@/lib/features/team/types/team-types";
import { buildHref } from "@/lib/features/team/utils/team-utils";

export function TeamPagination(props: {
  tab: TeamTab;
  page: number;
  pageSize: number;
  totalPages: number;
  prevPage: number;
  nextPage: number;
  hasPrev: boolean;
  hasNext: boolean;
  keyword: string;
  t: (key: LocaleKey) => string;
}) {
  const { tab, page, pageSize, totalPages, prevPage, nextPage, hasPrev, hasNext, keyword, t } = props;

  return (
    <section className="flex flex-wrap items-center justify-end gap-2">
      <a
        href={buildHref({ tab, page: 1, pageSize, q: keyword })}
        className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
          hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-50"
        }`}
      >
        {t("common.first")}
      </a>
      <a
        href={buildHref({ tab, page: prevPage, pageSize, q: keyword })}
        className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
          hasPrev ? "hover:bg-muted" : "pointer-events-none opacity-50"
        }`}
      >
        {t("common.prev")}
      </a>
      <span className="min-w-24 text-center text-sm text-muted-foreground">
        {t("common.page")}: {page}/{totalPages}
      </span>
      <PageSizeForm
        action="/team"
        pageSize={pageSize}
        hiddenInputs={[
          { name: "tab", value: tab },
          ...(keyword.trim() ? [{ name: "q", value: keyword.trim() }] : []),
          { name: "page", value: "1" },
        ]}
      />
      <a
        href={buildHref({ tab, page: nextPage, pageSize, q: keyword })}
        className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
          hasNext ? "hover:bg-muted" : "pointer-events-none opacity-50"
        }`}
      >
        {t("common.next")}
      </a>
      <a
        href={buildHref({ tab, page: totalPages, pageSize, q: keyword })}
        className={`inline-flex h-9 items-center rounded-lg border px-4 text-sm font-medium ${
          hasNext ? "hover:bg-muted" : "pointer-events-none opacity-50"
        }`}
      >
        {t("common.last")}
      </a>
    </section>
  );
}
