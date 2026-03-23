"use client";

import { Check } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import { InboxMessageBody } from "@/features/inbox/components/inbox-message-body";
import type { InboxMessage } from "@/lib/features/inbox/types/inbox-types";
import { formatCompactInboxTime } from "@/lib/features/inbox/utils/inbox-utils";

export function PortalInboxPreviewCard(props: {
  item: InboxMessage;
  locale: string;
  markingId: string | null;
  loading: boolean;
  markingAll: boolean;
  t: (key: LocaleKey) => string;
  onMarkRead: () => void;
}) {
  const { item, locale, markingId, loading, markingAll, t, onMarkRead } = props;
  const unread = !item.readAt;

  return (
    <div
      className={
        unread
          ? "rounded-xl border border-primary/25 bg-primary/5 px-3 py-3"
          : "rounded-xl border border-border bg-background px-3 py-3"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{item.title}</p>
            {unread ? (
              <Badge variant="default" className="h-4 px-1.5 text-[10px]">
                {t("inbox.unread")}
              </Badge>
            ) : null}
          </div>
          <InboxMessageBody
            body={item.body}
            className="mt-1 text-xs leading-5 text-muted-foreground"
          />
        </div>
        {unread ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onMarkRead}
            disabled={loading || markingAll || markingId === item.id}
            title={t("inbox.markRead")}
          >
            {markingId === item.id ? <Spinner className="size-4" /> : <Check className="h-4 w-4" />}
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{t("inbox.fromAdmin")}</span>
        <span className="shrink-0">{formatCompactInboxTime(item.createdAt, locale)}</span>
      </div>
    </div>
  );
}
