"use client";

import type { ReactNode } from "react";

function normalizeUrl(raw: string) {
  const trimmed = raw.replace(/[),.;!?]+$/g, "");
  const trailing = raw.slice(trimmed.length);
  return { url: trimmed, trailing };
}

export function InboxMessageBody({
  body,
  className = "",
}: {
  body: string;
  className?: string;
}) {
  const parts: ReactNode[] = [];
  const pattern = /https?:\/\/[^\s]+/g;
  let lastIndex = 0;

  for (const match of body.matchAll(pattern)) {
    const rawUrl = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(body.slice(lastIndex, index));
    }
    const { url, trailing } = normalizeUrl(rawUrl);
    parts.push(
      <a
        key={`${url}-${index}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {url}
      </a>,
    );
    if (trailing) parts.push(trailing);
    lastIndex = index + rawUrl.length;
  }

  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }

  return (
    <div className={`whitespace-pre-wrap break-words ${className}`.trim()}>
      {parts.length > 0 ? parts : body}
    </div>
  );
}
