"use client";

import { useState } from "react";
import type { LocaleKey } from "@/locales";
import type { TeamOwnerFillState } from "@/lib/features/team/types/team-types";
import { TEAM_OWNER_AUTO_FILL_TARGET } from "@/lib/features/team/utils/team-utils";

export function useTeamItemActions(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
  refreshTable: () => void;
}) {
  const { t, toast, refreshTable } = props;
  const [actingEmail, setActingEmail] = useState<string | null>(null);

  const disableOne = async (email: string) => {
    setActingEmail(email);
    try {
      const res = await fetch(`/api/team-accounts/${encodeURIComponent(email)}/disable`, {
        method: "POST",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("accounts.disabled"));
      refreshTable();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail(null);
    }
  };

  const enableOne = async (email: string) => {
    setActingEmail(email);
    try {
      const res = await fetch(`/api/team-accounts/${encodeURIComponent(email)}/enable`, {
        method: "POST",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("accounts.enabled"));
      refreshTable();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail(null);
    }
  };

  const reloginOne = async (email: string) => {
    setActingEmail(email);
    try {
      const res = await fetch(`/api/team-accounts/${encodeURIComponent(email)}/relogin`, {
        method: "POST",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("team.reloginSuccess").replace("{email}", email));
      refreshTable();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail(null);
    }
  };

  const loadOwnerFillState = async (email: string): Promise<TeamOwnerFillState> => {
    const slotsRes = await fetch(
      `/api/team-accounts/owner/${encodeURIComponent(email)}/available-slots`,
      {
        method: "GET",
        cache: "no-store",
      },
    );
    const slotsData = (await slotsRes.json().catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          teamMemberCount?: number;
          pendingInvites?: number;
          availableSlots?: number;
        }
      | null;
    if (!slotsRes.ok || !slotsData?.ok) {
      throw new Error(slotsData?.error ?? `HTTP ${slotsRes.status}`);
    }
    return {
      availableSlots: Math.max(0, Math.floor(Number(slotsData.availableSlots ?? 0))),
      missingMembers: Math.min(
        Math.max(
          0,
          TEAM_OWNER_AUTO_FILL_TARGET -
            Math.max(0, Math.floor(Number(slotsData.teamMemberCount ?? 0))) -
            Math.max(0, Math.floor(Number(slotsData.pendingInvites ?? 0))),
        ),
        Math.max(0, Math.floor(Number(slotsData.availableSlots ?? 0))),
      ),
    };
  };

  const queueAutoFillOwnerMembers = async (
    email: string,
    missingMembers: number,
    onDone: () => void,
  ) => {
    setActingEmail(email);
    try {
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
      onDone();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("accounts.autoFillMembersQueueFailed"),
      );
    } finally {
      setActingEmail((current) => (current === email ? null : current));
    }
  };

  const removeOneNow = async (email: string, onDone: () => void) => {
    setActingEmail(email);
    try {
      const res = await fetch(`/api/team-accounts/${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(t("accounts.removed"));
      onDone();
      refreshTable();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActingEmail(null);
    }
  };

  return {
    actingEmail,
    setActingEmail,
    disableOne,
    enableOne,
    reloginOne,
    loadOwnerFillState,
    queueAutoFillOwnerMembers,
    removeOneNow,
  };
}
