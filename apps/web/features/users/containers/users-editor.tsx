"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/providers/toast-provider";
import { useLocale } from "@/components/providers/locale-provider";
import { UserBalanceDialog } from "../components/user-balance-dialog";
import { UserConfirmDialog } from "../components/user-confirm-dialog";
import { UserCreateDialog } from "../components/user-create-dialog";
import { UserEditDialog } from "../components/user-edit-dialog";
import { UserMessageDialog } from "../components/user-message-dialog";
import { UsersPagination } from "../components/users-pagination";
import { UsersTable } from "../components/users-table";
import { UsersToolbar } from "../components/users-toolbar";
import type { MessageTargetMode, UserItem } from "@/lib/features/users/types/user-types";
import { useUserActions } from "../hooks/use-user-actions";
import { useUsersFilters } from "../hooks/use-users-filters";
import { useUserSelection } from "../hooks/use-user-selection";

export function UsersEditor({
  items,
  currentUserId,
  page,
  pageSize,
  total,
  initialSearch,
  initialRoleFilter,
  initialStatusFilter,
}: {
  items: UserItem[];
  currentUserId: string;
  page: number;
  pageSize: number;
  total: number;
  initialSearch: string;
  initialRoleFilter: "all" | "admin" | "user";
  initialStatusFilter: "all" | "enabled" | "disabled";
}) {
  const toast = useToast();
  const { t, locale } = useLocale();
  const router = useRouter();
  const [messageTargetMode, setMessageTargetMode] = useState<MessageTargetMode>("selected");
  const {
    search,
    roleFilter,
    statusFilter,
    setSearch,
    updateQuery,
    onRoleFilterChange,
    onStatusFilterChange,
  } = useUsersFilters({
    initialSearch,
    initialRoleFilter,
    initialStatusFilter,
  });
  const {
    selectedIdSet,
    filteredSelectableIds,
    selectedRecipients,
    filteredRecipients,
    selectedManageableRecipients,
    selectedCount,
    selectedManageableCount,
    messageTargetRecipients,
    messageTargetCount,
    canOpenMessageDialog,
    allChecked,
    clearSelection,
    toggleRowSelected,
    toggleAll,
    selectFiltered,
  } = useUserSelection({
    items,
    currentUserId,
    messageTargetMode,
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  const refresh = () => router.refresh();
  const {
    createOpen,
    creating,
    createUsername,
    createPassword,
    createRole,
    editOpen,
    editingUser,
    savingEdit,
    editRole,
    editEnabled,
    editPassword,
    editUserRpmLimit,
    editUserMaxInFlight,
    balanceOpen,
    balanceUser,
    balanceMode,
    balanceAmount,
    savingBalance,
    confirmOpen,
    confirmAction,
    mutating,
    messageOpen,
    sendingMessage,
    messageTitle,
    messageBody,
    confirmTitle,
    confirmDescription,
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
    createUser,
    saveEdit,
    saveBalance,
    sendInboxMessage,
    applyMutation,
  } = useUserActions({
    t,
    toast,
    clearSelection,
    refresh,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <UsersToolbar
          search={search}
          roleFilter={roleFilter}
          statusFilter={statusFilter}
          filteredSelectableCount={filteredSelectableIds.length}
          selectedCount={selectedCount}
          selectedManageableCount={selectedManageableCount}
          canOpenMessageDialog={canOpenMessageDialog}
          mutating={mutating}
          t={t}
          onSearchChange={setSearch}
          onRoleFilterChange={onRoleFilterChange}
          onStatusFilterChange={onStatusFilterChange}
          onSelectFiltered={selectFiltered}
          onClearSelection={clearSelection}
          onOpenMessage={() => {
            setMessageTargetMode(selectedCount > 0 ? "selected" : "filtered");
            onMessageOpenChange(true);
          }}
          onBatchEnable={() => openBatchConfirm("enable", selectedManageableRecipients)}
          onBatchDisable={() => openBatchConfirm("disable", selectedManageableRecipients)}
          onBatchDelete={() => openBatchConfirm("delete", selectedManageableRecipients)}
        />

        <UserCreateDialog
          open={createOpen}
          creating={creating}
          username={createUsername}
          password={createPassword}
          role={createRole}
          t={t}
          onOpenChange={onCreateOpenChange}
          onUsernameChange={setCreateUsername}
          onPasswordChange={setCreatePassword}
          onRoleChange={setCreateRole}
          onCreate={createUser}
        />
      </div>

      <UsersTable
        items={items}
        selectedIdSet={selectedIdSet}
        allChecked={allChecked}
        locale={locale}
        currentUserId={currentUserId}
        t={t}
        onToggleAll={toggleAll}
        onToggleRowSelected={toggleRowSelected}
        onEdit={openEdit}
        onEditBalance={openBalance}
        onConfirm={(item, action) => openSingleConfirm(action, item)}
      />
      <UsersPagination
        safePage={safePage}
        totalPages={totalPages}
        pageSize={pageSize}
        t={t}
        onPageChange={(nextPage) => updateQuery({ page: nextPage })}
        onPageSizeChange={(nextPageSize) => updateQuery({ pageSize: nextPageSize })}
      />

      <UserMessageDialog
        open={messageOpen}
        sending={sendingMessage}
        targetMode={messageTargetMode}
        recipients={messageTargetRecipients}
        selectedRecipients={selectedRecipients}
        filteredRecipients={filteredRecipients}
        title={messageTitle}
        body={messageBody}
        t={t}
        onOpenChange={onMessageOpenChange}
        onTargetModeChange={setMessageTargetMode}
        onTitleChange={setMessageTitle}
        onBodyChange={setMessageBody}
        onSend={() => sendInboxMessage(messageTargetRecipients, messageTargetCount)}
      />

      <UserEditDialog
        open={editOpen}
        saving={savingEdit}
        user={editingUser}
        role={editRole}
        enabled={editEnabled}
        password={editPassword}
        userRpmLimit={editUserRpmLimit}
        userMaxInFlight={editUserMaxInFlight}
        t={t}
        onOpenChange={onEditOpenChange}
        onRoleChange={setEditRole}
        onEnabledChange={setEditEnabled}
        onPasswordChange={setEditPassword}
        onUserRpmLimitChange={setEditUserRpmLimit}
        onUserMaxInFlightChange={setEditUserMaxInFlight}
        onSave={saveEdit}
      />

      <UserBalanceDialog
        open={balanceOpen}
        saving={savingBalance}
        user={balanceUser}
        mode={balanceMode}
        amount={balanceAmount}
        t={t}
        onOpenChange={onBalanceOpenChange}
        onModeChange={setBalanceMode}
        onAmountChange={setBalanceAmount}
        onSave={saveBalance}
      />

      <UserConfirmDialog
        open={confirmOpen}
        mutating={mutating}
        title={confirmTitle}
        description={confirmDescription}
        variant={confirmAction === "delete" ? "destructive" : "default"}
        onOpenChange={setConfirmOpen}
        onConfirm={applyMutation}
        cancelLabel={t("common.cancel")}
      />
    </div>
  );
}
