"use client";

import { useState } from "react";
import type { TeamOwnerMemberItem } from "@/lib/features/team/types/team-types";

export function useTeamOwnerMembers() {
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [membersDialogEmail, setMembersDialogEmail] = useState("");
  const [membersDialogLoading, setMembersDialogLoading] = useState(false);
  const [membersDialogError, setMembersDialogError] = useState<string | null>(null);
  const [membersDialogItems, setMembersDialogItems] = useState<TeamOwnerMemberItem[]>([]);

  const resetMembersDialog = () => {
    setMembersDialogEmail("");
    setMembersDialogError(null);
    setMembersDialogItems([]);
    setMembersDialogLoading(false);
  };

  const openMembers = async (email: string) => {
    setMembersDialogOpen(true);
    setMembersDialogEmail(email);
    setMembersDialogLoading(true);
    setMembersDialogError(null);
    setMembersDialogItems([]);
    try {
      const res = await fetch(`/api/team-accounts/owner/${encodeURIComponent(email)}/members`, {
        method: "GET",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            members?: TeamOwnerMemberItem[];
          }
        | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setMembersDialogItems(Array.isArray(data.members) ? data.members : []);
    } catch (error) {
      setMembersDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setMembersDialogLoading(false);
    }
  };

  return {
    membersDialogOpen,
    membersDialogEmail,
    membersDialogLoading,
    membersDialogError,
    membersDialogItems,
    setMembersDialogOpen,
    resetMembersDialog,
    openMembers,
  };
}
