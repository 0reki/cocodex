"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type { ConfirmDialogState } from "@/lib/features/team/types/team-types";

export function useTeamConfirmActions(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
  selectedEmails: string[];
  setBulkRemoving: React.Dispatch<React.SetStateAction<boolean>>;
  setBulkDisabling: React.Dispatch<React.SetStateAction<boolean>>;
  setActingEmail: React.Dispatch<React.SetStateAction<string | null>>;
  refreshTable: () => void;
  loadOwnerFillState: (email: string) => Promise<{
    availableSlots: number;
    missingMembers: number;
  }>;
  queueAutoFillOwnerMembers: (
    email: string,
    missingMembers: number,
    onDone: () => void,
  ) => Promise<void>;
  removeOneNow: (email: string, onDone: () => void) => Promise<void>;
}) {
  const {
    t,
    toast,
    selectedEmails,
    setBulkRemoving,
    setBulkDisabling,
    setActingEmail,
    refreshTable,
    loadOwnerFillState,
    queueAutoFillOwnerMembers,
    removeOneNow,
  } = props;
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
    setConfirmDialog((prev) => ({
      ...prev,
      open: false,
      action: null,
    }));
  };

  const bulkDisable = async () => {
    if (selectedEmails.length === 0) {
      toast.info(t("accounts.selectAtLeastOne"));
      return;
    }
    openConfirmDialog({
      title: t("team.confirmDisableTitle"),
      description: t("accounts.disableSelectedDescription").replace(
        "{count}",
        String(selectedEmails.length),
      ),
      confirmLabel: t("common.disable"),
      confirmVariant: "destructive",
      action: async () => {
        setBulkDisabling(true);
        try {
          const res = await fetch("/api/team-accounts/bulk-disable", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emails: selectedEmails }),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            updated?: number;
            error?: string;
          };
          if (!res.ok || !data.ok) {
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          toast.success(`${t("common.disable")} ${data.updated ?? selectedEmails.length}`);
          closeConfirmDialog();
          refreshTable();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setBulkDisabling(false);
        }
      },
    });
  };

  const bulkRemove = async () => {
    if (selectedEmails.length === 0) {
      toast.info(t("accounts.selectAtLeastOne"));
      return;
    }
    openConfirmDialog({
      title: t("team.confirmRemoveTitle"),
      description: t("accounts.removeSelectedDescription").replace(
        "{count}",
        String(selectedEmails.length),
      ),
      confirmLabel: t("common.remove"),
      confirmVariant: "destructive",
      action: async () => {
        setBulkRemoving(true);
        try {
          const res = await fetch("/api/team-accounts/bulk-remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ emails: selectedEmails }),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            deleted?: number;
            error?: string;
          };
          if (!res.ok || !data.ok) {
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          toast.success(`${t("common.remove")} ${data.deleted ?? selectedEmails.length}`);
          closeConfirmDialog();
          refreshTable();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setBulkRemoving(false);
        }
      },
    });
  };

  const autoFillOwnerMembers = async (email: string) => {
    setActingEmail(email);
    try {
      const { availableSlots, missingMembers } = await loadOwnerFillState(email);
      if (availableSlots <= 0) {
        toast.info(`${email} has no available team slots.`);
        return;
      }
      if (missingMembers <= 0) {
        toast.info(`${email} already has enough team members.`);
        return;
      }

      openConfirmDialog({
        title: t("accounts.autoFillMembersTitle"),
        description: t("accounts.autoFillMembersDescription")
          .replace("{email}", email)
          .replace("{count}", String(missingMembers)),
        confirmLabel: t("accounts.autoFillMembersConfirm"),
        confirmVariant: "default",
        action: async () => {
          await queueAutoFillOwnerMembers(email, missingMembers, closeConfirmDialog);
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail((current) => (current === email ? null : current));
    }
  };

  const removeOne = async (email: string) => {
    openConfirmDialog({
      title: t("team.confirmRemoveTitle"),
      description: t("accounts.removeAccountDescription").replace("{email}", email),
      confirmLabel: t("common.remove"),
      confirmVariant: "destructive",
      action: async () => removeOneNow(email, closeConfirmDialog),
    });
  };

  return {
    confirmDialog,
    closeConfirmDialog,
    bulkDisable,
    bulkRemove,
    autoFillOwnerMembers,
    removeOne,
  };
}
