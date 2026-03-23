"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type { UserItem } from "@/lib/features/users/types/user-types";
import { createInboxMessage } from "@/lib/features/users/api/user-api";

export function useUserInboxMutation(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
  messageTitle: string;
  messageBody: string;
  onMessageDone: () => void;
}) {
  const { t, toast, messageTitle, messageBody, onMessageDone } = props;
  const [sendingMessage, setSendingMessage] = useState(false);

  const sendInboxMessage = async (recipients: UserItem[], recipientCount: number) => {
    if (recipientCount === 0) {
      toast.error(t("inbox.recipientRequired"));
      return;
    }
    if (!messageTitle.trim()) {
      toast.error(t("inbox.titleRequired"));
      return;
    }
    if (!messageBody.trim()) {
      toast.error(t("inbox.bodyRequired"));
      return;
    }

    setSendingMessage(true);
    try {
      const data = await createInboxMessage({
        recipientUserIds: recipients.map((item) => item.id),
        title: messageTitle.trim(),
        body: messageBody.trim(),
      });
      toast.success(
        t("inbox.sendSuccess").replace("{count}", String(data.created ?? recipientCount)),
      );
      onMessageDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("inbox.sendFailed"));
    } finally {
      setSendingMessage(false);
    }
  };

  return {
    sendingMessage,
    sendInboxMessage,
  };
}
