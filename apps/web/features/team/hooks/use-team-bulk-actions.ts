"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type { TeamTab } from "@/lib/features/team/types/team-types";

export function useTeamBulkActions(props: {
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
  const [creatingAccounts, setCreatingAccounts] = useState(false);
  const [joiningTeam, setJoiningTeam] = useState(false);
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [bulkDisabling, setBulkDisabling] = useState(false);
  const [bulkRelogining, setBulkRelogining] = useState(false);

  const createAccounts = async (countValue: number, concurrencyValue: number, onDone: () => void) => {
    const count = Math.max(1, Math.floor(Number(countValue) || 1));
    const concurrency = Math.max(1, Math.min(count, Math.floor(Number(concurrencyValue) || 1)));
    if (availableCreateDomains.length === 0) {
      toast.error(tab === "owner" ? t("team.noOwnerMailDomains") : t("team.noCloudMailDomains"));
      return;
    }
    setCreatingAccounts(true);
    try {
      const res = await fetch(
        tab === "owner" ? "/api/team-accounts/owner/create" : "/api/team-accounts/member/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ count, concurrency }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        task?: { id?: string };
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        data.task?.id
          ? `${t("signup.taskPending")} ${t("signup.taskId")}: ${data.task.id}`
          : t("signup.taskPending"),
      );
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingAccounts(false);
    }
  };

  const joinSelectedMembersToTeam = async () => {
    if (selectedEmails.length === 0) {
      toast.info(t("accounts.selectAtLeastOne"));
      return;
    }
    setJoiningTeam(true);
    try {
      const res = await fetch("/api/team-accounts/member/join-team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberEmails: selectedEmails }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        task?: { id?: string };
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        data.task?.id
          ? `${t("signup.taskPending")} ${t("signup.taskId")}: ${data.task.id}`
          : t("signup.taskPending"),
      );
      clearSelection();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setJoiningTeam(false);
    }
  };

  const bulkRelogin = async () => {
    if (selectedEmails.length === 0) {
      toast.info(t("accounts.selectAtLeastOne"));
      return;
    }
    setBulkRelogining(true);
    try {
      const res = await fetch("/api/team-accounts/bulk-relogin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: selectedEmails }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        successCount?: number;
        failedCount?: number;
        results?: Array<{ email?: string; error?: string }>;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if ((data.failedCount ?? 0) > 0) {
        const firstError = data.results?.find((item) => item.error)?.error ?? "";
        toast.info(
          `${t("team.reloginPartial").replace("{success}", String(data.successCount ?? 0)).replace("{failed}", String(data.failedCount ?? 0))}${firstError ? `: ${firstError}` : ""}`,
        );
      } else {
        toast.success(
          t("team.reloginSelectedSuccess").replace(
            "{count}",
            String(data.successCount ?? selectedEmails.length),
          ),
        );
      }
      refreshTable();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkRelogining(false);
    }
  };

  return {
    creatingAccounts,
    joiningTeam,
    bulkRemoving,
    bulkDisabling,
    bulkRelogining,
    setBulkRemoving,
    setBulkDisabling,
    createAccounts,
    joinSelectedMembersToTeam,
    bulkRelogin,
  };
}
