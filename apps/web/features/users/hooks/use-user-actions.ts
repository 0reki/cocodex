"use client";

import type { LocaleKey } from "@/locales";
import { useUserDialogState } from "./use-user-dialog-state";
import { useUserMutations } from "./use-user-mutations";

export function useUserActions(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
  clearSelection: () => void;
  refresh: () => void;
}) {
  const { t, toast, clearSelection, refresh } = props;
  const dialogState = useUserDialogState();
  const mutations = useUserMutations({
    t,
    toast,
    clearSelection,
    refresh,
    createUsername: dialogState.createUsername,
    createPassword: dialogState.createPassword,
    createRole: dialogState.createRole,
    editingUser: dialogState.editingUser,
    editRole: dialogState.editRole,
    editEnabled: dialogState.editEnabled,
    editPassword: dialogState.editPassword,
    editUserRpmLimit: dialogState.editUserRpmLimit,
    editUserMaxInFlight: dialogState.editUserMaxInFlight,
    balanceUser: dialogState.balanceUser,
    balanceMode: dialogState.balanceMode,
    balanceAmount: dialogState.balanceAmount,
    messageTitle: dialogState.messageTitle,
    messageBody: dialogState.messageBody,
    confirmAction: dialogState.confirmAction,
    confirmTargetIds: dialogState.confirmTargetIds,
    confirmTargetName: dialogState.confirmTargetName,
    onCreateDone: () => dialogState.onCreateOpenChange(false),
    onEditDone: () => dialogState.onEditOpenChange(false),
    onBalanceDone: () => dialogState.onBalanceOpenChange(false),
    onMessageDone: () => dialogState.onMessageOpenChange(false),
    onConfirmDone: () => dialogState.setConfirmOpen(false),
  });

  return {
    ...dialogState,
    ...mutations,
  };
}
