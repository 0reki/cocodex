"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type {
  AccountItem,
  TeamOwnerAvailableSlotsResponse,
  TeamOwnerFillState,
} from "@/lib/features/accounts/types/account-types";
import { TEAM_OWNER_AUTO_FILL_TARGET } from "@/lib/features/accounts/utils/account-utils";

export function useAccountActions(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
  clearSelection: () => void;
  refresh: () => void;
}) {
  const { t, toast, clearSelection, refresh } = props;
  const [actingEmail, setActingEmail] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const removeEmails = async (emails: string[]) => {
    if (emails.length === 0) {
      toast.info(t("accounts.selectAtLeastOne"));
      return;
    }
    setRemoving(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; deleted?: number }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        data?.deleted && data.deleted > 1
          ? t("accounts.removed").replace("{count}", String(data.deleted))
          : t("accounts.removed"),
      );
      clearSelection();
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("accounts.remove"));
    } finally {
      setRemoving(false);
    }
  };

  const loadTeamOwnerFillState = async (email: string): Promise<TeamOwnerFillState> => {
    const res = await fetch(`/api/accounts/team-owner/${encodeURIComponent(email)}/available-slots`, {
      method: "GET",
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as TeamOwnerAvailableSlotsResponse | null;
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    const availableSlots = Math.max(0, Math.floor(Number(data.availableSlots ?? 0)));
    const teamMemberCount = Math.max(0, Math.floor(Number(data.teamMemberCount ?? 0)));
    const pendingInvites = Math.max(0, Math.floor(Number(data.pendingInvites ?? 0)));
    const missingMembers = Math.max(0, TEAM_OWNER_AUTO_FILL_TARGET - teamMemberCount - pendingInvites);
    return {
      availableSlots,
      missingMembers: Math.min(missingMembers, availableSlots),
    };
  };

  const disableOne = async (item: AccountItem) => {
    setActingEmail(item.email);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(item.email)}/disable`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("accounts.disabled"));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail((current) => (current === item.email ? null : current));
    }
  };

  const enableOne = async (item: AccountItem) => {
    setActingEmail(item.email);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(item.email)}/enable`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("accounts.enabled"));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail((current) => (current === item.email ? null : current));
    }
  };

  const testOne = async (item: AccountItem) => {
    setActingEmail(item.email);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(item.email)}/test`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("accounts.testSuccess"));
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail((current) => (current === item.email ? null : current));
    }
  };

  const queueAutoFill = async (email: string, missingMembers: number) => {
    const res = await fetch("/api/accounts/team-owner/fill-members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerEmail: email,
        count: missingMembers,
        concurrency: Math.min(missingMembers, 4),
      }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    toast.success(t("accounts.autoFillMembersQueued").replace("{count}", String(missingMembers)));
  };

  return {
    actingEmail,
    removing,
    setActingEmail,
    removeEmails,
    loadTeamOwnerFillState,
    disableOne,
    enableOne,
    testOne,
    queueAutoFill,
  };
}
