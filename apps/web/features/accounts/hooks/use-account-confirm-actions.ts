"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type {
  AccountItem,
  ConfirmDialogState,
  SavedAccountSummary,
  SubmitMode,
} from "@/lib/features/accounts/types/account-types";
import { shouldPromptTeamOwnerFill } from "@/lib/features/accounts/utils/account-utils";

export function useAccountConfirmActions(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
  selectedEmails: string[];
  removeEmails: (emails: string[]) => Promise<void>;
  loadTeamOwnerFillState: (email: string) => Promise<{
    availableSlots: number;
    missingMembers: number;
  }>;
  queueAutoFill: (email: string, missingMembers: number) => Promise<void>;
  setActingEmail: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const {
    t,
    toast,
    selectedEmails,
    removeEmails,
    loadTeamOwnerFillState,
    queueAutoFill,
    setActingEmail,
  } = props;
  const [confirming, setConfirming] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: "",
    description: "",
    confirmLabel: "",
    confirmVariant: "destructive",
    action: null,
  });

  const openConfirmDialog = (options: Omit<ConfirmDialogState, "open">) => {
    setConfirmDialog({
      open: true,
      ...options,
    });
  };

  const closeConfirmDialog = () => {
    setConfirmDialog((prev) => ({ ...prev, open: false, action: null }));
  };

  const queueAutoFillWithErrorHandling = async (email: string, missingMembers: number) => {
    try {
      await queueAutoFill(email, missingMembers);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("accounts.autoFillMembersQueueFailed"),
      );
    }
  };

  const maybePromptTeamOwnerFill = async (
    account: SavedAccountSummary | null,
    mode: SubmitMode,
  ) => {
    if (!shouldPromptTeamOwnerFill(account, mode) || !account) {
      return;
    }
    const { missingMembers } = await loadTeamOwnerFillState(account.email);
    if (missingMembers <= 0) return;

    openConfirmDialog({
      title: t("accounts.autoFillMembersTitle"),
      description: t("accounts.autoFillMembersDescription")
        .replace("{email}", account.email)
        .replace("{count}", String(missingMembers)),
      confirmLabel: t("accounts.autoFillMembersConfirm"),
      confirmVariant: "default",
      action: async () => {
        await queueAutoFillWithErrorHandling(account.email, missingMembers);
      },
    });
  };

  const autoFillTeamOwner = async (item: AccountItem) => {
    setActingEmail(item.email);
    try {
      const { availableSlots, missingMembers } = await loadTeamOwnerFillState(item.email);
      if (availableSlots <= 0) {
        toast.info(`${item.email} has no available team slots.`);
        return;
      }
      if (missingMembers <= 0) {
        toast.info(`${item.email} already has enough team members.`);
        return;
      }

      openConfirmDialog({
        title: t("accounts.autoFillMembersTitle"),
        description: t("accounts.autoFillMembersDescription")
          .replace("{email}", item.email)
          .replace("{count}", String(missingMembers)),
        confirmLabel: t("accounts.autoFillMembersConfirm"),
        confirmVariant: "default",
        action: async () => {
          await queueAutoFillWithErrorHandling(item.email, missingMembers);
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail((current) => (current === item.email ? null : current));
    }
  };

  const confirmRemoveSelected = () => {
    openConfirmDialog({
      title: t("accounts.removeSelectedTitle"),
      description: t("accounts.removeSelectedDescription").replace(
        "{count}",
        String(selectedEmails.length),
      ),
      confirmLabel: t("common.remove"),
      confirmVariant: "destructive",
      action: async () => {
        await removeEmails(selectedEmails);
      },
    });
  };

  const confirmRemoveOne = (email: string) => {
    openConfirmDialog({
      title: t("accounts.removeAccountTitle"),
      description: t("accounts.removeAccountDescription").replace("{email}", email),
      confirmLabel: t("common.remove"),
      confirmVariant: "destructive",
      action: async () => {
        await removeEmails([email]);
      },
    });
  };

  const onConfirmOpenChange = (open: boolean) => {
    if (confirming) return;
    setConfirmDialog((prev) => ({ ...prev, open, action: open ? prev.action : null }));
  };

  const onCancel = () => {
    setConfirmDialog((prev) => ({ ...prev, open: false, action: null }));
  };

  const onConfirm = async () => {
    const action = confirmDialog.action;
    if (!action) return;
    setConfirming(true);
    try {
      await action();
      setConfirmDialog((prev) => ({ ...prev, open: false, action: null }));
    } finally {
      setConfirming(false);
    }
  };

  return {
    confirming,
    confirmDialog,
    maybePromptTeamOwnerFill,
    autoFillTeamOwner,
    confirmRemoveSelected,
    confirmRemoveOne,
    onConfirmOpenChange,
    onCancel,
    onConfirm,
    closeConfirmDialog,
  };
}
