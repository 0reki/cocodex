"use client";

import { ChevronLeft } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import { InboxMessageBody } from "@/features/inbox/components/inbox-message-body";
import type { InboxMessage } from "@/lib/features/inbox/types/inbox-types";
import { formatInboxTime } from "@/lib/features/inbox/utils/inbox-utils";

export function InboxDetailPanel(props: {
  detail: InboxMessage | null;
  locale: string;
  unreadCount: number;
  loading: boolean;
  refreshing: boolean;
  deletingId: string | null;
  markingId: string | null;
  t: (key: LocaleKey) => string;
  onBack: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const {
    detail,
    locale,
    unreadCount,
    loading,
    refreshing,
    deletingId,
    markingId,
    t,
    onBack,
    onRefresh,
    onDelete,
  } = props;

  return (
    <section className="rounded-2xl border bg-card/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
        <Button type="button" variant="ghost" onClick={onBack} disabled={deletingId === detail?.id}>
          <ChevronLeft className="h-4 w-4" />
          {t("inbox.backToList")}
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {t("inbox.unread")}: {unreadCount}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing || loading || markingId === detail?.id || deletingId === detail?.id}
          >
            {refreshing ? <Spinner className="size-4" /> : t("inbox.refresh")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onDelete}
            disabled={loading || refreshing || !detail || deletingId === detail?.id}
          >
            {deletingId === detail?.id ? <Spinner className="size-4" /> : t("common.delete")}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
          <Spinner className="size-4" />
          <span className="ml-2">{t("inbox.loading")}</span>
        </div>
      ) : !detail ? (
        <div className="flex min-h-80 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {t("inbox.messageNotFound")}
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="border-b px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{detail.title}</h2>
              {!detail.readAt ? <Badge variant="default">{t("inbox.unread")}</Badge> : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>{t("inbox.fromAdmin")}</span>
              <span>{formatInboxTime(detail.createdAt, locale)}</span>
            </div>
            {detail.aiTranslated ? (
              <p className="mt-2 text-xs text-amber-700">{t("inbox.aiTranslatedNote")}</p>
            ) : null}
          </div>
          <div className="flex flex-1 flex-col gap-4 px-5 py-4">
            <InboxMessageBody body={detail.body} className="text-sm leading-7 text-foreground" />
          </div>
        </div>
      )}
    </section>
  );
}
