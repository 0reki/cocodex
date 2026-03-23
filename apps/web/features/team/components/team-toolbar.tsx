"use client";

import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import type { TeamTab } from "@/lib/features/team/types/team-types";
import { buildHref } from "@/lib/features/team/utils/team-utils";

export function TeamToolbar(props: {
  tab: TeamTab;
  keyword: string;
  pageSize: number;
  selectedEmailsCount: number;
  disabled: boolean;
  joiningTeam: boolean;
  bulkRemoving: boolean;
  bulkDisabling: boolean;
  bulkRelogining: boolean;
  t: (key: LocaleKey) => string;
  onOpenCreate: () => void;
  onJoinSelected: () => void;
  onBulkRelogin: () => void;
  onBulkRemove: () => void;
  onBulkDisable: () => void;
}) {
  const {
    tab,
    keyword,
    pageSize,
    selectedEmailsCount,
    disabled,
    joiningTeam,
    bulkRemoving,
    bulkDisabling,
    bulkRelogining,
    t,
    onOpenCreate,
    onJoinSelected,
    onBulkRelogin,
    onBulkRemove,
    onBulkDisable,
  } = props;

  return (
    <section className="flex flex-wrap items-center justify-between gap-3">
      <form action="/team" method="get" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="tab" value={tab} />
        <input type="hidden" name="page" value="1" />
        <input type="hidden" name="pageSize" value={String(pageSize)} />
        <input
          name="q"
          defaultValue={keyword}
          placeholder={t("team.filterPlaceholder")}
          className="h-8 w-48 rounded-lg border px-2 text-sm"
        />
        <Button type="submit" variant="outline">
          {t("common.apply")}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {keyword.trim() ? (
          <a
            href={buildHref({ tab, page: 1, pageSize })}
            className="inline-flex h-8 items-center rounded-lg border px-3 text-sm hover:bg-muted"
          >
            {t("common.clear")}
          </a>
        ) : null}
        {tab === "member" || tab === "owner" ? (
          <Button onClick={onOpenCreate} disabled={disabled}>
            {t("team.addAccounts")}
          </Button>
        ) : null}
        {tab === "member" ? (
          <Button variant="outline" onClick={onJoinSelected} disabled={disabled || selectedEmailsCount === 0}>
            {joiningTeam ? <Spinner /> : `${t("team.joinTeam")}(${selectedEmailsCount})`}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onBulkRelogin} disabled={disabled || selectedEmailsCount === 0}>
          {bulkRelogining ? <Spinner /> : `${t("team.relogin")}(${selectedEmailsCount})`}
        </Button>
        <Button variant="destructive" onClick={onBulkRemove} disabled={disabled || selectedEmailsCount === 0}>
          {bulkRemoving ? <Spinner /> : `${t("common.remove")}(${selectedEmailsCount})`}
        </Button>
        <Button variant="outline" onClick={onBulkDisable} disabled={disabled || selectedEmailsCount === 0}>
          {bulkDisabling ? <Spinner /> : `${t("common.disable")}(${selectedEmailsCount})`}
        </Button>
      </div>
    </section>
  );
}
