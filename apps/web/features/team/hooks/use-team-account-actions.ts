"use client";

import type { LocaleKey } from "@/locales";
import type { TeamTab } from "@/lib/features/team/types/team-types";
import { useTeamBulkActions } from "./use-team-bulk-actions";
import { useTeamItemActions } from "./use-team-item-actions";

export function useTeamAccountActions(props: {
  tab: TeamTab;
  availableCreateDomains: string[];
  selectedEmails: string[];
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
  clearSelection: () => void;
  refreshTable: () => void;
}) {
  const { tab, availableCreateDomains, selectedEmails, t, toast, clearSelection, refreshTable } = props;
  const bulkActions = useTeamBulkActions({
    tab,
    availableCreateDomains,
    selectedEmails,
    t,
    toast,
    clearSelection,
    refreshTable,
  });
  const itemActions = useTeamItemActions({
    t,
    toast,
    refreshTable,
  });

  return {
    ...bulkActions,
    ...itemActions,
  };
}
