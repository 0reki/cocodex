"use client";

import { useEffect, useState } from "react";
import type { LocaleKey } from "@/locales";
import type { InboxMessage } from "@/lib/features/inbox/types/inbox-types";
import { mapInboxMessage, normalizeUnreadCount } from "@/lib/features/inbox/utils/inbox-utils";

export function useInboxCenter(props: {
  detailId: string;
  isDetailView: boolean;
  t: (key: LocaleKey) => string;
  toast: {
    error: (message: string) => void;
  };
}) {
  const { detailId, isDetailView, t, toast } = props;
  const [items, setItems] = useState<InboxMessage[]>([]);
  const [detail, setDetail] = useState<InboxMessage | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const loadInbox = async (showError = true) => {
    const setter = loading ? setLoading : setRefreshing;
    setter(true);
    try {
      const url = isDetailView
        ? `/api/inbox?detail=${encodeURIComponent(detailId)}`
        : `/api/inbox?limit=100${unreadOnly ? "&unread=1" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = (await res.json()) as {
        error?: string;
        unreadCount?: number;
        detail?: {
          id?: string;
          senderUsername?: string | null;
          title?: string;
          body?: string;
          aiTranslated?: boolean;
          readAt?: string | null;
          createdAt?: string;
        } | null;
        items?: Array<{
          id?: string;
          senderUsername?: string | null;
          title?: string;
          body?: string;
          aiTranslated?: boolean;
          readAt?: string | null;
          createdAt?: string;
        }>;
      };
      if (!res.ok) {
        throw new Error(data.error ?? t("inbox.loadFailed"));
      }

      setUnreadCount(normalizeUnreadCount(data.unreadCount));
      if (isDetailView) {
        setItems([]);
        setDetail(data.detail ? mapInboxMessage(data.detail) : null);
      } else {
        setDetail(null);
        setItems(
          (data.items ?? [])
            .map((item) => mapInboxMessage(item))
            .filter((item): item is InboxMessage => Boolean(item)),
        );
      }
    } catch (error) {
      if (showError) {
        toast.error(error instanceof Error ? error.message : t("inbox.loadFailed"));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const markRead = async (ids?: string[]) => {
    try {
      const res = await fetch("/api/inbox", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
      });
      const data = (await res.json()) as {
        error?: string;
        unreadCount?: number;
      };
      if (!res.ok) {
        throw new Error(data.error ?? t("inbox.readFailed"));
      }

      const readAt = new Date().toISOString();
      if (isDetailView) {
        setDetail((prev) => (prev && (!ids || ids.includes(prev.id)) ? { ...prev, readAt } : prev));
      } else {
        setItems((prev) =>
          unreadOnly
            ? ids && ids.length > 0
              ? prev.filter((item) => !ids.includes(item.id))
              : []
            : prev.map((item) => (!ids || ids.includes(item.id) ? { ...item, readAt } : item)),
        );
      }
      setUnreadCount(normalizeUnreadCount(data.unreadCount));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("inbox.readFailed"));
    }
  };

  const deleteMessages = async (ids: string[]) => {
    try {
      const res = await fetch("/api/inbox", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = (await res.json()) as {
        error?: string;
        unreadCount?: number;
      };
      if (!res.ok) {
        throw new Error(data.error ?? t("inbox.deleteFailed"));
      }
      setUnreadCount(normalizeUnreadCount(data.unreadCount));
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("inbox.deleteFailed"));
      return false;
    }
  };

  useEffect(() => {
    void loadInbox(false);
  }, [detailId, unreadOnly]);

  useEffect(() => {
    if (!detail || detail.readAt) return;
    setMarkingId(detail.id);
    void markRead([detail.id]).finally(() => setMarkingId(null));
  }, [detail]);

  return {
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
    markAllRead: () => {
      setMarkingAll(true);
      void markRead().finally(() => setMarkingAll(false));
    },
  };
}
