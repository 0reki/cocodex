import type { InboxMessage } from "../types/inbox-types";

export function formatInboxTime(value: string, locale: string) {
  const date = new Date(value);
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCompactInboxTime(value: string, locale: string) {
  const date = new Date(value);
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeUnreadCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

export function mapInboxMessage(item: {
  id?: string;
  senderUsername?: string | null;
  title?: string;
  body?: string;
  aiTranslated?: boolean;
  readAt?: string | null;
  createdAt?: string;
}): InboxMessage | null {
  const mapped = {
    id: typeof item.id === "string" ? item.id : "",
    senderUsername: typeof item.senderUsername === "string" ? item.senderUsername : null,
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    aiTranslated: item.aiTranslated === true,
    readAt: typeof item.readAt === "string" ? item.readAt : null,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
  };
  return mapped.id && mapped.title && mapped.createdAt ? mapped : null;
}
