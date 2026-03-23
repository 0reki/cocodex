"use client";

import { Badge } from "@workspace/ui/components/badge";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import type { InboxMessage } from "@/lib/features/inbox/types/inbox-types";
import { formatInboxTime } from "@/lib/features/inbox/utils/inbox-utils";

export function InboxListItem(props: {
  item: InboxMessage;
  locale: string;
  markingId: string | null;
  t: (key: LocaleKey) => string;
  onOpen: () => void;
}) {
  const { item, locale, markingId, t, onOpen } = props;
  const unread = !item.readAt;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
        unread ? "border-primary/20 bg-primary/5 hover:bg-primary/8" : "border-border hover:bg-muted/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">{item.title}</p>
            {unread ? (
              <Badge variant="default" className="h-4 px-1.5 text-[10px]">
                {t("inbox.unread")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {item.body}
          </p>
        </div>
        {markingId === item.id ? <Spinner className="size-4" /> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{t("inbox.fromAdmin")}</span>
        <span className="shrink-0">{formatInboxTime(item.createdAt, locale)}</span>
      </div>
    </button>
  );
}
