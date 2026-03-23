"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TeamAccountRecord } from "@workspace/database";
import { useLocale } from "@/components/providers/locale-provider";
import { useToast } from "@/components/providers/toast-provider";
import { TeamAccountsGrid } from "./team-accounts-grid";
import { TeamConfirmDialog } from "./team-confirm-dialog";
import { TeamCreateDialog } from "./team-create-dialog";
import { TeamOwnerMembersDialog } from "./team-owner-members-dialog";
import { TeamPagination } from "./team-pagination";
import { TeamToolbar } from "./team-toolbar";
import { useTeamAccountActions } from "../hooks/use-team-account-actions";
import { useTeamConfirmActions } from "../hooks/use-team-confirm-actions";
import { useTeamOwnerMembers } from "../hooks/use-team-owner-members";
import { useTeamSelection } from "../hooks/use-team-selection";
import { useTeamTableMeta } from "../hooks/use-team-table-meta";
import type { TeamTab } from "@/lib/features/team/types/team-types";

export function TeamAccountsTable({
  items,
  page,
  pageSize,
  total,
  tab,
  keyword,
  showOwnerColumns = false,
  cloudMailDomains = [],
  ownerMailDomains = [],
}: {
  items: TeamAccountRecord[];
  page: number;
  pageSize: number;
  total: number;
  tab: TeamTab;
  keyword: string;
  showOwnerColumns?: boolean;
  cloudMailDomains?: string[];
  ownerMailDomains?: string[];
}) {
  const { t } = useLocale();
  const toast = useToast();
  const router = useRouter();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createCount, setCreateCount] = useState(1);
  const [createConcurrency, setCreateConcurrency] = useState(1);
  const { selected, selectedEmails, allChecked, clearSelection, toggleAll, toggleOne } =
    useTeamSelection(items);
  const {
    totalPages,
    prevPage,
    nextPage,
    hasPrev,
    hasNext,
    columnCount,
    availableCreateDomains,
  } = useTeamTableMeta({
    page,
    pageSize,
    total,
    tab,
    showOwnerColumns,
    cloudMailDomains,
    ownerMailDomains,
  });
  const {
    membersDialogOpen,
    membersDialogEmail,
    membersDialogLoading,
    membersDialogError,
    membersDialogItems,
    setMembersDialogOpen,
    resetMembersDialog,
    openMembers,
  } = useTeamOwnerMembers();
  const refreshTable = () => {
    clearSelection();
    router.refresh();
  };
  const {
    creatingAccounts,
    joiningTeam,
    bulkRemoving,
    bulkDisabling,
    bulkRelogining,
    actingEmail,
    setBulkRemoving,
    setBulkDisabling,
    setActingEmail,
    createAccounts,
    joinSelectedMembersToTeam,
    bulkRelogin,
    disableOne,
    enableOne,
    reloginOne,
    loadOwnerFillState,
    queueAutoFillOwnerMembers,
    removeOneNow,
  } = useTeamAccountActions({
    tab,
    availableCreateDomains,
    selectedEmails,
    t,
    toast,
    clearSelection,
    refreshTable,
  });
  const {
    confirmDialog,
    closeConfirmDialog,
    bulkDisable,
    bulkRemove,
    autoFillOwnerMembers,
    removeOne,
  } = useTeamConfirmActions({
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
  });

  return (
    <>
      <TeamToolbar
        tab={tab}
        keyword={keyword}
        pageSize={pageSize}
        selectedEmailsCount={selectedEmails.length}
        disabled={
          creatingAccounts ||
          joiningTeam ||
          bulkRemoving ||
          bulkDisabling ||
          bulkRelogining
        }
        joiningTeam={joiningTeam}
        bulkRemoving={bulkRemoving}
        bulkDisabling={bulkDisabling}
        bulkRelogining={bulkRelogining}
        t={t}
        onOpenCreate={() => setCreateDialogOpen(true)}
        onJoinSelected={() => void joinSelectedMembersToTeam()}
        onBulkRelogin={bulkRelogin}
        onBulkRemove={bulkRemove}
        onBulkDisable={bulkDisable}
      />

      <TeamAccountsGrid
        items={items}
        showOwnerColumns={showOwnerColumns}
        columnCount={columnCount}
        allChecked={allChecked}
        selected={selected}
        actingEmail={actingEmail}
        creatingAccounts={creatingAccounts}
        joiningTeam={joiningTeam}
        bulkRemoving={bulkRemoving}
        bulkDisabling={bulkDisabling}
        bulkRelogining={bulkRelogining}
        t={t}
        onToggleAll={toggleAll}
        onToggleOne={toggleOne}
        onViewMembers={(email) => {
          setActingEmail(email);
          void openMembers(email).finally(() => {
            setActingEmail((current) => (current === email ? null : current));
          });
        }}
        onAutoFillMembers={(email) => void autoFillOwnerMembers(email)}
        onRelogin={(email) => void reloginOne(email)}
        onToggleEnabled={(item) =>
          item.workspaceIsDeactivated ? void enableOne(item.email) : void disableOne(item.email)
        }
        onRemove={(email) => void removeOne(email)}
      />

      <TeamPagination
        tab={tab}
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        prevPage={prevPage}
        nextPage={nextPage}
        hasPrev={hasPrev}
        hasNext={hasNext}
        keyword={keyword}
        t={t}
      />

      <TeamCreateDialog
        open={createDialogOpen}
        creating={creatingAccounts}
        count={createCount}
        concurrency={createConcurrency}
        availableDomains={availableCreateDomains}
        tab={tab}
        t={t}
        onOpenChange={setCreateDialogOpen}
        onCountChange={setCreateCount}
        onConcurrencyChange={setCreateConcurrency}
        onCreate={() =>
          void createAccounts(createCount, createConcurrency, () => {
            setCreateDialogOpen(false);
            setCreateCount(1);
            setCreateConcurrency(1);
          })
        }
      />

      <TeamOwnerMembersDialog
        open={membersDialogOpen}
        email={membersDialogEmail}
        loading={membersDialogLoading}
        error={membersDialogError}
        items={membersDialogItems}
        t={t}
        onOpenChange={(open) => {
          setMembersDialogOpen(open);
          if (!open) {
            resetMembersDialog();
          }
        }}
      />

      <TeamConfirmDialog
        dialog={confirmDialog}
        busy={bulkRemoving || bulkDisabling || actingEmail !== null}
        t={t}
        onOpenChange={(open) => !open && closeConfirmDialog()}
        onCancel={closeConfirmDialog}
        onConfirm={() => void confirmDialog.action?.()}
      />

    </>
  );
}
