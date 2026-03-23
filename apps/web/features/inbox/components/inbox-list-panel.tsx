"use client";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import { InboxListItem } from "@/features/inbox/components/inbox-list-item";
import type { InboxMessage } from "@/lib/features/inbox/types/inbox-types";

export function InboxListPanel(props: {
  items: InboxMessage[];
  unreadOnly: boolean;
  unreadCount: number;
  loading: boolean;
  refreshing: boolean;
  markingAll: boolean;
  markingId: string | null;
  locale: string;
  t: (key: LocaleKey) => string;
  onShowAll: () => void;
  onShowUnread: () => void;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  onOpenItem: (id: string) => void;
}) {
  const {
    items,
    unreadOnly,
    unreadCount,
    loading,
    refreshing,
    markingAll,
    markingId,
    locale,
    t,
    onShowAll,
    onShowUnread,
    onRefresh,
    onMarkAllRead,
    onOpenItem,
  } = props;

  return (
    <section className="rounded-2xl border bg-card/40">
      <div>
        <div className="border-b px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant={unreadOnly ? "outline" : "default"} size="sm" onClick={onShowAll}>
                {t("inbox.allMessages")}
              </Button>
              <Button type="button" variant={unreadOnly ? "default" : "outline"} size="sm" onClick={onShowUnread}>
                {t("inbox.unreadOnly")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <Badge variant="outline" className="shrink-0">
                {t("inbox.unread")}: {unreadCount}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRefresh}
                disabled={refreshing || loading || markingAll || Boolean(markingId)}
              >
                {refreshing ? <Spinner className="size-4" /> : t("inbox.refresh")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onMarkAllRead}
                disabled={unreadCount === 0 || loading || refreshing || markingAll}
              >
                {markingAll ? <Spinner className="size-4" /> : t("inbox.markAllRead")}
              </Button>
            </div>
          </div>
        </div>

        <div className="max-h-[calc(100svh-13rem)] overflow-y-auto p-2">
          {loading ? (
            <div className="flex min-h-60 items-center justify-center text-sm text-muted-foreground">
              <Spinner className="size-4" />
              <span className="ml-2">{t("inbox.loading")}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-h-60 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {unreadOnly ? t("inbox.emptyUnread") : t("inbox.empty")}
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((item) => (
                <InboxListItem
                  key={item.id}
                  item={item}
                  locale={locale}
                  markingId={markingId}
                  t={t}
                  onOpen={() => onOpenItem(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
