"use client";

import { useMemo, useState } from "react";
import type { LocaleKey } from "@/locales";
import type { UserItem } from "@/lib/features/users/types/user-types";
import {
  createAdminUser,
  deleteAdminUser,
  setAdminUserEnabled,
  updateAdminUser,
  updateAdminUserBalance,
} from "@/lib/features/users/api/user-api";

export function useUserAccountMutations(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
  clearSelection: () => void;
  refresh: () => void;
  createUsername: string;
  createPassword: string;
  createRole: "admin" | "user";
  editingUser: UserItem | null;
  editRole: "admin" | "user";
  editEnabled: "enabled" | "disabled";
  editPassword: string;
  editUserRpmLimit: string;
  editUserMaxInFlight: string;
  balanceUser: UserItem | null;
  balanceMode: "set" | "adjust";
  balanceAmount: string;
  confirmAction: "enable" | "disable" | "delete";
  confirmTargetIds: string[];
  confirmTargetName: string;
  onCreateDone: () => void;
  onEditDone: () => void;
  onBalanceDone: () => void;
  onConfirmDone: () => void;
}) {
  const {
    t,
    toast,
    clearSelection,
    refresh,
    createUsername,
    createPassword,
    createRole,
    editingUser,
    editRole,
    editEnabled,
    editPassword,
    editUserRpmLimit,
    editUserMaxInFlight,
    balanceUser,
    balanceMode,
    balanceAmount,
    confirmAction,
    confirmTargetIds,
    confirmTargetName,
    onCreateDone,
    onEditDone,
    onBalanceDone,
    onConfirmDone,
  } = props;
  const [creating, setCreating] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [savingBalance, setSavingBalance] = useState(false);
  const [mutating, setMutating] = useState(false);

  const confirmTitle = useMemo(
    () =>
      confirmAction === "delete"
        ? t("common.delete")
        : confirmAction === "enable"
          ? t("common.enable")
          : t("common.disable"),
    [confirmAction, t],
  );
  const confirmDescription = confirmTargetName
    ? `${confirmTitle} ${confirmTargetName}?`
    : `${confirmTitle} ${confirmTargetIds.length} users?`;

  const createUser = async () => {
    setCreating(true);
    try {
      await createAdminUser({
        username: createUsername,
        password: createPassword,
        role: createRole,
      });
      toast.success(t("users.createSuccess"));
      onCreateDone();
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("users.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const saveEdit = async () => {
    if (!editingUser) return;
    setSavingEdit(true);
    try {
      await updateAdminUser(editingUser.id, {
        role: editRole,
        enabled: editEnabled === "enabled",
        password: editPassword.length >= 8 ? editPassword : undefined,
        userRpmLimit: editUserRpmLimit.trim() ? Number(editUserRpmLimit) : null,
        userMaxInFlight: editUserMaxInFlight.trim() ? Number(editUserMaxInFlight) : null,
      });
      toast.success(t("users.roleUpdated"));
      onEditDone();
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("users.updateFailed"));
    } finally {
      setSavingEdit(false);
    }
  };

  const saveBalance = async () => {
    if (!balanceUser) return;
    const amount = Number(balanceAmount);
    if (!Number.isFinite(amount)) {
      toast.error(t("users.updateFailed"));
      return;
    }
    setSavingBalance(true);
    try {
      await updateAdminUserBalance(balanceUser.id, { mode: balanceMode, amount });
      toast.success(t("users.balanceUpdated"));
      onBalanceDone();
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("users.updateFailed"));
    } finally {
      setSavingBalance(false);
    }
  };

  const applyMutation = async () => {
    if (confirmTargetIds.length === 0) {
      onConfirmDone();
      return;
    }
    setMutating(true);
    try {
      if (confirmAction === "delete") {
        for (const id of confirmTargetIds) {
          await deleteAdminUser(id, t("users.deleteFailed"));
        }
        toast.success(t("users.deleteSuccess"));
      } else {
        const enabled = confirmAction === "enable";
        for (const id of confirmTargetIds) {
          await setAdminUserEnabled(id, enabled, t("users.updateFailed"));
        }
        toast.success(enabled ? t("users.userEnabled") : t("users.userDisabled"));
      }
      onConfirmDone();
      clearSelection();
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("users.updateFailed"));
    } finally {
      setMutating(false);
    }
  };

  return {
    creating,
    savingEdit,
    savingBalance,
    mutating,
    confirmTitle,
    confirmDescription,
    createUser,
    saveEdit,
    saveBalance,
    applyMutation,
  };
}
