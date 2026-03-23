"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { OpenAIAccountRecord, TeamAccountRecord } from "@workspace/database";
import { useLocale } from "@/components/providers/locale-provider";
import { useToast } from "@/components/providers/toast-provider";
import { AccountsTable } from "../components/accounts-table";
import { AccountsPagination } from "../components/accounts-pagination";
import { AccountSubmitDialog } from "../components/account-submit-dialog";
import { AccountsToolbar } from "../components/accounts-toolbar";
import { ConfirmActionDialog } from "../components/confirm-action-dialog";
import { TeamOwnerMembersDialog } from "../components/team-owner-members-dialog";
import { useAccountActions } from "../hooks/use-account-actions";
import { useAccountConfirmActions } from "../hooks/use-account-confirm-actions";
import { useAccountSubmitFlow } from "../hooks/use-account-submit-flow";
import { useAccountsTableState } from "../hooks/use-accounts-table-state";
import { useTeamOwnerMembers } from "../hooks/use-team-owner-members";
import {
  buildAccountItems,
  normalizeTeamMemberRole,
  normalizeTeamMemberStatus,
} from "@/lib/features/accounts/utils/account-utils";

export function AccountsWorkspaceEditor({
  openaiAccounts,
  teamAccounts,
}: {
  openaiAccounts: OpenAIAccountRecord[];
  teamAccounts: TeamAccountRecord[];
}) {
  const router = useRouter();
  const toast = useToast();
  const { t } = useLocale();
  const items = useMemo(
    () => buildAccountItems(openaiAccounts, teamAccounts),
    [openaiAccounts, teamAccounts],
  );
  const {
    selected,
    search,
    kindFilter,
    statusFilter,
    pageSize,
    filteredItems,
    selectedEmails,
    totalPages,
    safePage,
    pagedItems,
    allChecked,
    filterKindOptions,
    clearSelection,
    setSearch,
    setKindFilter,
    setStatusFilter,
    setPage,
    setPageSize,
    setSelected,
    toggleAll,
  } = useAccountsTableState({ items, t });
  const {
    membersDialogOpen,
    membersDialogEmail,
    membersDialogLoading,
    membersDialogError,
    membersDialogItems,
    membersInviteEmail,
    membersInviteSubmitting,
    membersRemovingEmail,
    setMembersDialogOpen,
    setMembersInviteEmail,
    resetMembersDialog,
    openMembers,
    inviteMember,
    removeMember,
  } = useTeamOwnerMembers({ toast });
  const refresh = () => router.refresh();
  const {
    actingEmail,
    removing,
    setActingEmail,
    removeEmails,
    loadTeamOwnerFillState,
    disableOne,
    enableOne,
    testOne,
    queueAutoFill,
  } = useAccountActions({
    t,
    toast,
    clearSelection,
    refresh,
  });
  const {
    confirming,
    confirmDialog,
    maybePromptTeamOwnerFill,
    autoFillTeamOwner,
    confirmRemoveSelected,
    confirmRemoveOne,
    onConfirmOpenChange,
    onCancel,
    onConfirm,
  } = useAccountConfirmActions({
    t,
    toast,
    selectedEmails,
    removeEmails,
    loadTeamOwnerFillState,
    queueAutoFill,
    setActingEmail,
  });

  const {
    submitOpen,
    submitMode,
    submitting,
    form,
    loginSessionId,
    requiresManualOtp,
    workspaceChoices,
    selectedWorkspaceId,
    setSubmitOpen,
    setSelectedWorkspaceId,
    setForm,
    closeSubmitDialog,
    submitAccount,
    verifyOtp,
    completeWorkspaceSelection,
    openReloginDialog,
  } = useAccountSubmitFlow({
    t,
    toast,
    refresh,
    setActingEmail,
    onAccountSaved: maybePromptTeamOwnerFill,
  });

  return (
    <section className="space-y-4">
      <AccountsToolbar
        search={search}
        kindFilter={kindFilter}
        statusFilter={statusFilter}
        removing={removing}
        selectedEmailsCount={selectedEmails.length}
        filterKindOptions={filterKindOptions}
        t={t}
        onSearchChange={setSearch}
        onKindFilterChange={setKindFilter}
        onStatusFilterChange={setStatusFilter}
        onRefresh={() => router.refresh()}
        onSubmit={() => setSubmitOpen(true)}
        onRemoveSelected={confirmRemoveSelected}
      />

      <AccountsTable
        filteredItems={filteredItems}
        pagedItems={pagedItems}
        selected={selected}
        allChecked={allChecked}
        actingEmail={actingEmail}
        t={t}
        onToggleAll={toggleAll}
        onSetSelected={setSelected}
        onTest={(item) => void testOne(item)}
        onViewMembers={(item) => {
          setActingEmail(item.email);
          void openMembers(item.email).finally(() => {
            setActingEmail((current) => (current === item.email ? null : current));
          });
        }}
        onAutoFillMembers={(item) => void autoFillTeamOwner(item)}
        onToggleEnabled={(item) => {
          const isDisabled =
            ("status" in item && (item.status ?? "").trim().toLowerCase() === "disabled") ||
            item.workspaceIsDeactivated;
          if (isDisabled) {
            void enableOne(item);
            return;
          }
          void disableOne(item);
        }}
        onRelogin={openReloginDialog}
        onRemove={confirmRemoveOne}
      />

      <AccountsPagination
        safePage={safePage}
        totalPages={totalPages}
        pageSize={pageSize}
        t={t}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <AccountSubmitDialog
        open={submitOpen}
        submitMode={submitMode}
        submitting={submitting}
        loginSessionId={loginSessionId}
        requiresManualOtp={requiresManualOtp}
        workspaceChoices={workspaceChoices}
        selectedWorkspaceId={selectedWorkspaceId}
        form={form}
        t={t}
        onOpenChange={(open) => {
          if (!open) {
            closeSubmitDialog();
            return;
          }
          setSubmitOpen(true);
        }}
        onFormChange={(field, value) => setForm((prev) => ({ ...prev, [field]: value }))}
        onSelectedWorkspaceIdChange={setSelectedWorkspaceId}
        onClose={closeSubmitDialog}
        onSubmit={
          workspaceChoices.length > 0
            ? completeWorkspaceSelection
            : requiresManualOtp && loginSessionId
              ? verifyOtp
              : submitAccount
        }
      />

      <TeamOwnerMembersDialog
        open={membersDialogOpen}
        ownerEmail={membersDialogEmail}
        loading={membersDialogLoading}
        error={membersDialogError}
        items={membersDialogItems}
        inviteEmail={membersInviteEmail}
        inviteSubmitting={membersInviteSubmitting}
        removingEmail={membersRemovingEmail}
        t={t}
        normalizeRole={normalizeTeamMemberRole}
        normalizeStatus={normalizeTeamMemberStatus}
        onOpenChange={(open) => {
          setMembersDialogOpen(open);
          if (!open) {
            resetMembersDialog();
          }
        }}
        onInviteEmailChange={setMembersInviteEmail}
        onInvite={() => void inviteMember()}
        onRemove={(member) => void removeMember(member)}
      />

      <ConfirmActionDialog
        dialog={confirmDialog}
        confirming={confirming}
        t={t}
        onOpenChange={onConfirmOpenChange}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </section>
  );
}
