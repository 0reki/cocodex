"use client";

import { useState } from "react";
import type {
  BalanceMode,
  BatchAction,
  UserEditStatus,
  UserItem,
} from "@/lib/features/users/types/user-types";

export function useUserDialogState() {
  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<"admin" | "user">("user");

  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserItem | null>(null);
  const [editRole, setEditRole] = useState<"admin" | "user">("user");
  const [editEnabled, setEditEnabled] = useState<UserEditStatus>("enabled");
  const [editPassword, setEditPassword] = useState("");
  const [editUserRpmLimit, setEditUserRpmLimit] = useState("");
  const [editUserMaxInFlight, setEditUserMaxInFlight] = useState("");

  const [balanceOpen, setBalanceOpen] = useState(false);
  const [balanceUser, setBalanceUser] = useState<UserItem | null>(null);
  const [balanceMode, setBalanceMode] = useState<BalanceMode>("set");
  const [balanceAmount, setBalanceAmount] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<BatchAction>("disable");
  const [confirmTargetIds, setConfirmTargetIds] = useState<string[]>([]);
  const [confirmTargetName, setConfirmTargetName] = useState("");

  const [messageOpen, setMessageOpen] = useState(false);
  const [messageTitle, setMessageTitle] = useState("");
  const [messageBody, setMessageBody] = useState("");

  const resetCreateForm = () => {
    setCreateUsername("");
    setCreatePassword("");
    setCreateRole("user");
  };

  const resetMessageDialog = () => {
    setMessageTitle("");
    setMessageBody("");
  };

  const onCreateOpenChange = (open: boolean) => {
    setCreateOpen(open);
    if (!open) resetCreateForm();
  };

  const onEditOpenChange = (open: boolean) => {
    setEditOpen(open);
    if (!open) {
      setEditingUser(null);
      setEditPassword("");
      setEditUserRpmLimit("");
      setEditUserMaxInFlight("");
    }
  };

  const onBalanceOpenChange = (open: boolean) => {
    setBalanceOpen(open);
    if (!open) setBalanceUser(null);
  };

  const onMessageOpenChange = (open: boolean) => {
    setMessageOpen(open);
    if (!open) resetMessageDialog();
  };

  const openEdit = (user: UserItem) => {
    setEditingUser(user);
    setEditRole(user.role);
    setEditEnabled(user.enabled ? "enabled" : "disabled");
    setEditPassword("");
    setEditUserRpmLimit(
      user.userRpmLimit == null ? "" : String(Math.max(0, Math.floor(user.userRpmLimit))),
    );
    setEditUserMaxInFlight(
      user.userMaxInFlight == null
        ? ""
        : String(Math.max(0, Math.floor(user.userMaxInFlight))),
    );
    setEditOpen(true);
  };

  const openBalance = (user: UserItem) => {
    setBalanceUser(user);
    setBalanceMode("set");
    setBalanceAmount(String(user.balance));
    setBalanceOpen(true);
  };

  const openSingleConfirm = (action: BatchAction, user: UserItem) => {
    setConfirmAction(action);
    setConfirmTargetIds([user.id]);
    setConfirmTargetName(user.username);
    setConfirmOpen(true);
  };

  const openBatchConfirm = (action: BatchAction, users: UserItem[]) => {
    if (users.length === 0) return;
    setConfirmAction(action);
    setConfirmTargetIds(users.map((item) => item.id));
    setConfirmTargetName("");
    setConfirmOpen(true);
  };

  return {
    createOpen,
    createUsername,
    createPassword,
    createRole,
    editOpen,
    editingUser,
    editRole,
    editEnabled,
    editPassword,
    editUserRpmLimit,
    editUserMaxInFlight,
    balanceOpen,
    balanceUser,
    balanceMode,
    balanceAmount,
    confirmOpen,
    confirmAction,
    confirmTargetIds,
    confirmTargetName,
    messageOpen,
    messageTitle,
    messageBody,
    setCreateUsername,
    setCreatePassword,
    setCreateRole,
    setEditRole,
    setEditEnabled,
    setEditPassword,
    setEditUserRpmLimit,
    setEditUserMaxInFlight,
    setBalanceMode,
    setBalanceAmount,
    setMessageTitle,
    setMessageBody,
    setConfirmOpen,
    onCreateOpenChange,
    onEditOpenChange,
    onBalanceOpenChange,
    onMessageOpenChange,
    openEdit,
    openBalance,
    openSingleConfirm,
    openBatchConfirm,
  };
}
