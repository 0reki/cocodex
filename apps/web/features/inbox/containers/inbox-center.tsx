"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "@/components/providers/locale-provider";
import { useToast } from "@/components/providers/toast-provider";
import { InboxDetailPanel } from "../components/inbox-detail-panel";
import { InboxListPanel } from "../components/inbox-list-panel";
import { useInboxCenter } from "../hooks/use-inbox-center";

export function InboxCenter() {
  const toast = useToast();
  const { locale, t } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const detailId = searchParams.get("detail")?.trim() ?? "";
  const isDetailView = detailId.length > 0;
  const {
    items,
    detail,
    unreadCount,
    loading,
    refreshing,
    markingAll,
    markingId,
    deletingId,
    unreadOnly,
    setDeletingId,
    setUnreadOnly,
    loadInbox,
    deleteMessages,
    markAllRead,
  } = useInboxCenter({
    detailId,
    isDetailView,
    t,
    toast,
  });

  if (isDetailView) {
    return (
      <InboxDetailPanel
        detail={detail}
        locale={locale}
        unreadCount={unreadCount}
        loading={loading}
        refreshing={refreshing}
        deletingId={deletingId}
        markingId={markingId}
        t={t}
        onBack={() => router.push("/inbox")}
        onRefresh={() => void loadInbox()}
        onDelete={() => {
          if (!detail) return;
          setDeletingId(detail.id);
          void deleteMessages([detail.id])
            .then((ok) => {
              if (ok) {
                toast.success(t("inbox.deleteSuccess"));
                router.push("/inbox");
              }
            })
            .finally(() => setDeletingId(null));
        }}
      />
    );
  }

  return (
    <InboxListPanel
      items={items}
      unreadOnly={unreadOnly}
      unreadCount={unreadCount}
      loading={loading}
      refreshing={refreshing}
      markingAll={markingAll}
      markingId={markingId}
      locale={locale}
      t={t}
      onShowAll={() => setUnreadOnly(false)}
      onShowUnread={() => setUnreadOnly(true)}
      onRefresh={() => void loadInbox()}
      onMarkAllRead={markAllRead}
      onOpenItem={(messageId) => {
        router.push(`/inbox?detail=${encodeURIComponent(messageId)}`);
      }}
    />
  );
}
