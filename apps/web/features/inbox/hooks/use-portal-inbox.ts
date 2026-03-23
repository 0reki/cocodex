"use client";

import { useCallback, useEffect, useState } from "react";
import type { LocaleKey } from "@/locales";
import type { InboxMessage } from "@/lib/features/inbox/types/inbox-types";
import { mapInboxMessage, normalizeUnreadCount } from "@/lib/features/inbox/utils/inbox-utils";

export function usePortalInbox(props: {
  t: (key: LocaleKey) => string;
  toast: {
    error: (message: string) => void;
  };
}) {
  const { t, toast } = props;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const loadInbox = useCallback(
    async (showError = true) => {
      setLoading(true);
      try {
        const res = await fetch("/api/inbox?limit=12", { cache: "no-store" });
        const data = (await res.json()) as {
          error?: string;
          unreadCount?: number;
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
        setMessages(
          (data.items ?? [])
            .map((item) => mapInboxMessage(item))
            .filter((item): item is InboxMessage => Boolean(item)),
        );
        setUnreadCount(normalizeUnreadCount(data.unreadCount));
        setLoadedOnce(true);
      } catch (error) {
        if (showError) {
          toast.error(error instanceof Error ? error.message : t("inbox.loadFailed"));
        }
      } finally {
        setLoading(false);
      }
    },
    [t, toast],
  );

  const markRead = useCallback(
    async (ids?: string[]) => {
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
        setMessages((prev) =>
          prev.map((item) => (!ids || ids.includes(item.id) ? { ...item, readAt } : item)),
        );
        setUnreadCount(normalizeUnreadCount(data.unreadCount));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("inbox.readFailed"));
      }
    },
    [t, toast],
  );

  useEffect(() => {
    void loadInbox(false);
    const timer = window.setInterval(() => {
      void loadInbox(false);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [loadInbox]);

  useEffect(() => {
    if (!open) return;
    void loadInbox(false);
  }, [open, loadInbox]);

  return {
    open,
    loading,
    loadedOnce,
    markingAll,
    markingId,
    messages,
    unreadCount,
    setOpen,
    loadInbox,
    markRead,
    markAllRead: () => {
      setMarkingAll(true);
      void markRead().finally(() => setMarkingAll(false));
    },
    markOneRead: (messageId: string) => {
      setMarkingId(messageId);
      void markRead([messageId]).finally(() => setMarkingId(null));
    },
  };
}
