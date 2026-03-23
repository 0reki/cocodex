"use client";

import { useState } from "react";
import type { TeamOwnerMemberItem } from "@/lib/features/accounts/types/account-types";

export function useTeamOwnerMembers(opts: {
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
}) {
  const { toast } = opts;
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const [membersDialogEmail, setMembersDialogEmail] = useState("");
  const [membersDialogLoading, setMembersDialogLoading] = useState(false);
  const [membersDialogError, setMembersDialogError] = useState<string | null>(null);
  const [membersDialogItems, setMembersDialogItems] = useState<TeamOwnerMemberItem[]>([]);
  const [membersInviteEmail, setMembersInviteEmail] = useState("");
  const [membersInviteSubmitting, setMembersInviteSubmitting] = useState(false);
  const [membersRemovingEmail, setMembersRemovingEmail] = useState<string | null>(null);

  const resetMembersDialog = () => {
    setMembersDialogEmail("");
    setMembersDialogLoading(false);
    setMembersDialogError(null);
    setMembersDialogItems([]);
    setMembersInviteEmail("");
    setMembersInviteSubmitting(false);
    setMembersRemovingEmail(null);
  };

  const reloadTeamOwnerMembers = async (ownerEmail: string) => {
    const res = await fetch(`/api/accounts/team-owner/${encodeURIComponent(ownerEmail)}/members`, {
      method: "GET",
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; members?: TeamOwnerMemberItem[] }
      | null;
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    setMembersDialogItems(Array.isArray(data.members) ? data.members : []);
  };

  const openMembers = async (ownerEmail: string) => {
    setMembersDialogOpen(true);
    setMembersDialogEmail(ownerEmail);
    setMembersDialogLoading(true);
    setMembersDialogError(null);
    setMembersDialogItems([]);
    try {
      await reloadTeamOwnerMembers(ownerEmail);
    } catch (error) {
      setMembersDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setMembersDialogLoading(false);
    }
  };

  const inviteMember = async () => {
    const ownerEmail = membersDialogEmail.trim().toLowerCase();
    const memberEmail = membersInviteEmail.trim().toLowerCase();
    if (!ownerEmail || !memberEmail) return;
    setMembersInviteSubmitting(true);
    try {
      const res = await fetch(`/api/accounts/team-owner/${encodeURIComponent(ownerEmail)}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberEmail }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setMembersInviteEmail("");
      await reloadTeamOwnerMembers(ownerEmail);
      toast.success("邀请已发送");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMembersInviteSubmitting(false);
    }
  };

  const removeMember = async (member: TeamOwnerMemberItem) => {
    const ownerEmail = membersDialogEmail.trim().toLowerCase();
    if (!ownerEmail || !member.email) return;
    setMembersRemovingEmail(member.email);
    try {
      const res = await fetch(`/api/accounts/team-owner/${encodeURIComponent(ownerEmail)}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberEmail: member.email,
          status: member.status,
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      await reloadTeamOwnerMembers(ownerEmail);
      toast.success("成员已移除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMembersRemovingEmail(null);
    }
  };

  return {
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
  };
}
