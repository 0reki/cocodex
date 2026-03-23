"use client";

import type { LocaleKey } from "@/locales";
import type { UserItem } from "@/lib/features/users/types/user-types";
import { useUserAccountMutations } from "./use-user-account-mutations";
import { useUserInboxMutation } from "./use-user-inbox-mutation";

export function useUserMutations(props: {
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
  messageTitle: string;
  messageBody: string;
  confirmAction: "enable" | "disable" | "delete";
  confirmTargetIds: string[];
  confirmTargetName: string;
  onCreateDone: () => void;
  onEditDone: () => void;
  onBalanceDone: () => void;
  onMessageDone: () => void;
  onConfirmDone: () => void;
}) {
  const accountMutations = useUserAccountMutations(props);
  const inboxMutation = useUserInboxMutation(props);

  return {
    ...accountMutations,
    ...inboxMutation,
  };
}
