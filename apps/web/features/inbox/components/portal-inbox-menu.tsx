"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckCheck, Mail, RefreshCcw } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { Spinner } from "@workspace/ui/components/spinner";
import { cn } from "@workspace/ui/lib/utils";
import { useLocale } from "@/components/providers/locale-provider";
import { useToast } from "@/components/providers/toast-provider";
import { PortalInboxPreviewCard } from "./portal-inbox-preview-card";
import { usePortalInbox } from "../hooks/use-portal-inbox";

function InboxTriggerIcon({
  unreadBadge,
  unreadBadgeCompact,
}: {
  unreadBadge: string;
  unreadBadgeCompact: boolean;
}) {
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center">
      <Mail className="h-4 w-4" />
      {unreadBadge ? (
        <span
          className={`absolute inline-flex items-center justify-center rounded-full bg-primary font-semibold leading-none text-primary-foreground ring-1 ring-background shadow-sm ${unreadBadgeCompact
              ? "-top-1 -right-1 h-3 min-w-4 px-[2px] text-[7px]"
              : "-top-0.5 -right-0.5 h-2.5 min-w-2.5 px-0 text-[7px]"
            }`}
        >
          {unreadBadge}
        </span>
      ) : null}
    </span>
  );
}

export function PortalInboxMenu({
  onNavigateStart,
}: {
  onNavigateStart?: (href: string) => void;
}) {
  const toast = useToast();
  const pathname = usePathname();
  const { locale, t } = useLocale();
  const {
    open,
    loading,
    loadedOnce,
    markingAll,
    markingId,
    messages,
    unreadCount,
    setOpen,
    loadInbox,
    markAllRead,
    markOneRead,
  } = usePortalInbox({
    t,
    toast,
  });

  const unreadBadge = unreadCount > 9 ? "9+" : unreadCount > 0 ? String(unreadCount) : "";
  const unreadBadgeCompact = unreadBadge.length > 1;
  const inboxHref = "/inbox";
  const inboxActive = pathname === inboxHref;
  const triggerClassName = cn(
    "relative h-full cursor-pointer items-center px-2 transition-colors hover:bg-muted sm:px-3",
    inboxActive && "bg-muted",
  );

  return (
    <>
      <Link
        href={inboxHref}
        onClick={() => onNavigateStart?.(inboxHref)}
        className={cn("inline-flex sm:hidden", triggerClassName)}
        aria-label={t("page.inbox")}
        title={t("page.inbox")}
        aria-current={inboxActive ? "page" : undefined}
      >
        <InboxTriggerIcon
          unreadBadge={unreadBadge}
          unreadBadgeCompact={unreadBadgeCompact}
        />
      </Link>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "hidden data-[state=open]:bg-muted sm:inline-flex",
              triggerClassName,
            )}
            aria-label={t("page.inbox")}
            title={t("page.inbox")}
          >
            <InboxTriggerIcon
              unreadBadge={unreadBadge}
              unreadBadgeCompact={unreadBadgeCompact}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(24rem,calc(100vw-1rem))] gap-0 overflow-hidden p-0"
        >
          <div className="border-b px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <PopoverHeader className="gap-1">
                <PopoverTitle className="flex items-center gap-2">
                  <span>{t("page.inbox")}</span>
                  <Badge variant={unreadCount > 0 ? "default" : "outline"}>
                    {t("inbox.unread")}: {unreadCount}
                  </Badge>
                </PopoverTitle>
              </PopoverHeader>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void loadInbox()}
                  disabled={loading || markingAll || Boolean(markingId)}
                  title={t("inbox.refresh")}
                >
                  {loading ? (
                    <Spinner className="size-4" />
                  ) : (
                    <RefreshCcw className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={markAllRead}
                  disabled={
                    unreadCount === 0 || loading || markingAll || Boolean(markingId)
                  }
                >
                  {markingAll ? (
                    <Spinner className="size-4" />
                  ) : (
                    <CheckCheck className="h-4 w-4" />
                  )}
                  <span>{t("inbox.markAllRead")}</span>
                </Button>
              </div>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto p-2">
            {loading && !loadedOnce ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
                <Spinner className="size-4" />
                <span className="ml-2">{t("inbox.loading")}</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
                {t("inbox.empty")}
              </div>
            ) : (
              <div className="space-y-2">
                {messages.map((item) => (
                  <PortalInboxPreviewCard
                    key={item.id}
                    item={item}
                    locale={locale}
                    markingId={markingId}
                    loading={loading}
                    markingAll={markingAll}
                    t={t}
                    onMarkRead={() => markOneRead(item.id)}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="border-t p-2">
            <Button asChild variant="ghost" className="w-full justify-center">
              <Link
                href={inboxHref}
                onClick={() => {
                  setOpen(false);
                  onNavigateStart?.(inboxHref);
                }}
              >
                {t("inbox.viewAll")}
              </Link>
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
