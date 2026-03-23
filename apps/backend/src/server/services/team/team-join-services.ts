import * as openaiApiModule from "@workspace/openai-api";
import type { TeamAccountRecord } from "@workspace/database";

export function createTeamJoinServices(deps: {
  teamOwnerMaxMembers: number;
  authUserAgent: string;
  listTeamOwnerAccountsPage: (
    page: number,
    pageSize: number,
  ) => Promise<{ items: TeamAccountRecord[] }>;
  getTeamOwnerAccountByEmail: (email: string) => Promise<any>;
  refreshAccessTokenByRefreshToken: (args: {
    refreshToken: string;
    userAgent?: string;
  }) => Promise<{ accessToken: string; refreshToken?: string | null }>;
  reloginTeamAccount: (
    input:
      | string
      | { email: string; targetAccountId?: string | null; ownerId?: string | null },
  ) => Promise<unknown>;
}) {
  const openaiUserAgent =
    process.env.CODEX_AUTH_USER_AGENT?.trim() ||
    "Apifox/1.0.0 (https://apifox.com)";
  const teamOwnerJoinLocks = new Map<string, Promise<void>>();

  async function withTeamOwnerJoinLock<T>(
    ownerEmail: string,
    handler: () => Promise<T>,
  ) {
    const key = ownerEmail.trim().toLowerCase();
    const pending = teamOwnerJoinLocks.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    teamOwnerJoinLocks.set(key, pending.then(() => current));
    await pending;
    try {
      return await handler();
    } finally {
      releaseLock();
      if (teamOwnerJoinLocks.get(key) === current) {
        teamOwnerJoinLocks.delete(key);
      }
    }
  }

  function getTeamOwnerAvailableSlots(account: TeamAccountRecord) {
    const used = Math.max(0, account.teamMemberCount ?? 0);
    return Math.max(0, deps.teamOwnerMaxMembers - used);
  }

  async function loadTeamOwnerAccessContextByEmail(ownerEmail: string) {
    const normalizedOwnerEmail = ownerEmail.trim().toLowerCase();
    if (!normalizedOwnerEmail) throw new Error("ownerEmail is required");
    const owner = await deps.getTeamOwnerAccountByEmail(normalizedOwnerEmail);
    if (!owner) throw new Error("Owner account not found");
    if (owner.planType !== "team") throw new Error("Owner account is not on team plan");
    if (!owner.accountId) throw new Error("Owner account is missing accountId");
    let ownerAccessToken = owner.accessToken?.trim() ?? "";
    const ownerRefreshToken = owner.refreshToken?.trim() ?? "";
    if (!ownerAccessToken) {
      if (!ownerRefreshToken) {
        throw new Error("Owner account has no usable access token");
      }
      const refreshed = await deps.refreshAccessTokenByRefreshToken({
        refreshToken: ownerRefreshToken,
        userAgent: deps.authUserAgent,
      });
      ownerAccessToken = refreshed.accessToken;
    }
    return {
      owner,
      ownerEmail: normalizedOwnerEmail,
      ownerAccountId: owner.accountId,
      ownerAccessToken,
    };
  }

  async function countPendingTeamInvites(options: {
    ownerAccountId: string;
    ownerAccessToken: string;
  }) {
    const payload = await fetchPendingTeamInvitesPayload(options);
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total)
        ? Math.max(0, Math.trunc(payload.total))
        : null;
    if (total !== null) return total;
    return Array.isArray(payload.items) ? payload.items.length : 0;
  }

  async function fetchPendingTeamInvitesPayload(options: {
    ownerAccountId: string;
    ownerAccessToken: string;
  }) {
    const accountId = options.ownerAccountId.trim();
    if (!accountId) throw new Error("Owner account is missing accountId");
    if (typeof openaiApiModule.listAccountInvites !== "function") {
      throw new Error("listAccountInvites is not available");
    }
    return (await openaiApiModule.listAccountInvites({
      accessToken: options.ownerAccessToken,
      accountId,
      userAgent: openaiUserAgent,
    })) as {
      total?: unknown;
      items?: unknown[];
    };
  }

  async function listPendingTeamInvites(options: {
    ownerAccountId: string;
    ownerAccessToken: string;
  }) {
    const payload = await fetchPendingTeamInvitesPayload(options);
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const emailCandidates = [
          record.email,
          record.email_address,
          record.recipient_email,
          record.invited_email,
        ];
        const email = emailCandidates.find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        if (!email) return null;
        const role =
          typeof record.role === "string" && record.role.trim()
            ? record.role.trim()
            : "standard-user";
        return {
          email: email.trim().toLowerCase(),
          role,
        };
      })
      .filter((item): item is { email: string; role: string } => Boolean(item));
  }

  async function listActiveTeamUsers(options: {
    ownerAccountId: string;
    ownerAccessToken: string;
  }) {
    if (typeof openaiApiModule.listAccountUsers !== "function") {
      throw new Error("listAccountUsers is not available");
    }
    const payload = (await openaiApiModule.listAccountUsers({
      accessToken: options.ownerAccessToken,
      accountId: options.ownerAccountId,
      limit: 25,
      offset: 0,
      query: "",
      userAgent: openaiUserAgent,
    })) as {
      items?: Array<{
        id?: string | null;
        email?: string | null;
        role?: string | null;
        seat_type?: string | null;
        name?: string | null;
        created_time?: string | null;
        deactivated_time?: string | null;
      }>;
    };
    return Array.isArray(payload.items)
      ? payload.items.map((item) => ({
          id: item.id?.trim() || "",
          email: item.email?.trim().toLowerCase() || "",
          role: item.role?.trim() || null,
          seatType: item.seat_type?.trim() || null,
          name: item.name?.trim() || null,
          status: item.deactivated_time?.trim() ? "disabled" : "active",
        }))
      : [];
  }

  async function inviteMembersToTeam(options: {
    ownerAccountId: string;
    ownerAccessToken: string;
    memberEmails: string[];
  }) {
    const accountId = options.ownerAccountId.trim();
    if (!accountId) throw new Error("Owner account is missing accountId");
    const emails = options.memberEmails
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length === 0) throw new Error("memberEmails is required");
    console.info(
      `[team-join] invite-start ownerAccountId=${accountId} count=${emails.length}`,
    );
    if (typeof openaiApiModule.createAccountInvites !== "function") {
      throw new Error("createAccountInvites is not available");
    }
    const payload = await openaiApiModule.createAccountInvites({
      accessToken: options.ownerAccessToken,
      accountId,
      emailAddresses: emails,
      role: "standard-user",
      resendEmail: false,
      userAgent: openaiUserAgent,
    });
    console.info(
      `[team-join] invite-done ownerAccountId=${accountId} count=${emails.length}`,
    );
    return payload;
  }

  async function revokeTeamInviteByEmail(options: {
    ownerAccountId: string;
    ownerAccessToken: string;
    email: string;
  }) {
    const accountId = options.ownerAccountId.trim();
    if (!accountId) throw new Error("Owner account is missing accountId");
    const email = options.email.trim().toLowerCase();
    if (!email) throw new Error("email is required");
    console.info(`[team-join] invite-revoke-start ownerAccountId=${accountId} email=${email}`);
    if (typeof openaiApiModule.deleteAccountInvite !== "function") {
      throw new Error("deleteAccountInvite is not available");
    }
    const payload = await openaiApiModule.deleteAccountInvite({
      accessToken: options.ownerAccessToken,
      accountId,
      emailAddress: email,
      userAgent: openaiUserAgent,
    });
    console.info(`[team-join] invite-revoke-done ownerAccountId=${accountId} email=${email}`);
    return payload;
  }

  async function listAvailableTeamOwners() {
    const data = await deps.listTeamOwnerAccountsPage(1, 500);
    return data.items
      .filter(
        (item) =>
          item.planType === "team" &&
          !item.workspaceIsDeactivated &&
          getTeamOwnerAvailableSlots(item) > 0 &&
          typeof item.accountId === "string" &&
          item.accountId.trim().length > 0,
      )
      .sort((a, b) => {
        const slotDiff = getTeamOwnerAvailableSlots(b) - getTeamOwnerAvailableSlots(a);
        if (slotDiff !== 0) return slotDiff;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .map((item) => ({
        id: item.id,
        email: item.email,
        accountId: item.accountId,
        workspaceName: item.workspaceName,
        teamMemberCount: item.teamMemberCount ?? 0,
        availableSlots: getTeamOwnerAvailableSlots(item),
      }));
  }

  async function getTeamOwnerEffectiveAvailableSlotsByEmail(ownerEmail: string) {
    const { ownerEmail: normalizedOwnerEmail, ownerAccountId, ownerAccessToken } =
      await loadTeamOwnerAccessContextByEmail(ownerEmail);
    const activeMembers = await listActiveTeamUsers({
      ownerAccountId,
      ownerAccessToken,
    });
    const pendingInvites = await countPendingTeamInvites({
      ownerAccountId,
      ownerAccessToken,
    });
    const memberCount = activeMembers.filter((item) => item.status === "active").length;
    const availableSlots = Math.max(
      0,
      deps.teamOwnerMaxMembers - memberCount - pendingInvites,
    );
    return {
      ownerEmail: normalizedOwnerEmail,
      ownerAccountId,
      teamMemberCount: memberCount,
      pendingInvites,
      availableSlots,
    };
  }

  async function listTeamOwnerMembersByEmail(ownerEmail: string) {
    const { ownerEmail: normalizedOwnerEmail, ownerAccountId, ownerAccessToken } =
      await loadTeamOwnerAccessContextByEmail(ownerEmail);
    const activeMembers = await listActiveTeamUsers({
      ownerAccountId,
      ownerAccessToken,
    });
    const pendingInvites = await listPendingTeamInvites({
      ownerAccountId,
      ownerAccessToken,
    });
    const membersByEmail = new Map(
      activeMembers
        .filter((item) => item.email)
        .map((item) => [item.email, item] as const),
    );
    for (const invite of pendingInvites) {
      if (membersByEmail.has(invite.email)) continue;
      membersByEmail.set(invite.email, {
        id: "",
        email: invite.email,
        role: invite.role,
        seatType: null,
        name: null,
        status: "pending",
      });
    }
    const members = Array.from(membersByEmail.values()).sort((a, b) =>
      a.email.localeCompare(b.email),
    );
    return {
      ownerEmail: normalizedOwnerEmail,
      ownerAccountId,
      members,
      total: members.length,
    };
  }

  async function inviteTeamOwnerMemberByEmail(ownerEmail: string, memberEmail: string) {
    const normalizedMemberEmail = memberEmail.trim().toLowerCase();
    if (!normalizedMemberEmail) throw new Error("memberEmail is required");
    const { ownerAccountId, ownerAccessToken } = await loadTeamOwnerAccessContextByEmail(ownerEmail);
    await inviteMembersToTeam({
      ownerAccountId,
      ownerAccessToken,
      memberEmails: [normalizedMemberEmail],
    });
    return {
      ownerEmail: ownerEmail.trim().toLowerCase(),
      memberEmail: normalizedMemberEmail,
    };
  }

  async function removeTeamOwnerMemberByEmail(
    ownerEmail: string,
    memberEmail: string,
  ) {
    const normalizedMemberEmail = memberEmail.trim().toLowerCase();
    if (!normalizedMemberEmail) throw new Error("memberEmail is required");
    const {
      ownerAccountId,
      ownerAccessToken,
      ownerEmail: normalizedOwnerEmail,
    } = await loadTeamOwnerAccessContextByEmail(ownerEmail);
    if (
      typeof openaiApiModule.listAccountUsers !== "function" ||
      typeof openaiApiModule.deleteAccountUser !== "function"
    ) {
      throw new Error("Team member management APIs are not available");
    }
    const payload = (await openaiApiModule.listAccountUsers({
      accessToken: ownerAccessToken,
      accountId: ownerAccountId,
      limit: 25,
      offset: 0,
      query: "",
      userAgent: openaiUserAgent,
    })) as {
      items?: Array<{ id?: string | null; email?: string | null }>;
    };
    const matchedUser =
      (Array.isArray(payload.items) ? payload.items : []).find(
        (item) => item.email?.trim().toLowerCase() === normalizedMemberEmail && item.id?.trim(),
      ) ?? null;
    if (matchedUser?.id) {
      await openaiApiModule.deleteAccountUser({
        accessToken: ownerAccessToken,
        accountId: ownerAccountId,
        userId: matchedUser.id.trim(),
        userAgent: openaiUserAgent,
      });
      return {
        ownerEmail: normalizedOwnerEmail,
        memberEmail: normalizedMemberEmail,
        removedStatus: "active",
      };
    }
    const pendingInvites = await listPendingTeamInvites({
      ownerAccountId,
      ownerAccessToken,
    });
    if (!pendingInvites.some((item) => item.email === normalizedMemberEmail)) {
      throw new Error(`Team member not found: ${normalizedMemberEmail}`);
    }
    await revokeTeamInviteByEmail({
      ownerAccountId,
      ownerAccessToken,
      email: normalizedMemberEmail,
    });
    return {
      ownerEmail: normalizedOwnerEmail,
      memberEmail: normalizedMemberEmail,
      removedStatus: "pending",
    };
  }

  async function joinMembersToOwnerTeam(options: {
    ownerEmail: string;
    memberEmails: string[];
    skipInvite?: boolean;
    ensureNotStopped?: () => void;
    onMemberProcessed?: (result: {
      email: string;
      ok: boolean;
      error?: string;
      skipped?: boolean;
    }) => void | Promise<void>;
  }) {
    const normalizedOwnerEmail = options.ownerEmail.trim().toLowerCase();
    const normalizedMemberEmails = Array.from(
      new Set(options.memberEmails.map((item) => item.trim().toLowerCase()).filter(Boolean)),
    );
    if (!normalizedOwnerEmail) throw new Error("ownerEmail is required");
    if (normalizedMemberEmails.length === 0) throw new Error("memberEmails is required");
    return withTeamOwnerJoinLock(normalizedOwnerEmail, async () => {
      console.info(
        `[team-join] join-start owner=${normalizedOwnerEmail} requested=${normalizedMemberEmails.length} skipInvite=${options.skipInvite ? "true" : "false"}`,
      );
      const owner = await deps.getTeamOwnerAccountByEmail(normalizedOwnerEmail);
      if (!owner) throw new Error("Owner account not found");
      if (owner.planType !== "team") throw new Error("Owner account is not on team plan");
      if (!owner.accountId) throw new Error("Owner account is missing accountId");
      const availableSlots = getTeamOwnerAvailableSlots(owner);
      const acceptedEmails = normalizedMemberEmails.slice(0, availableSlots);
      const overflowEmails = normalizedMemberEmails.slice(availableSlots);
      const results: Array<{ email: string; ok: boolean; error?: string; skipped?: boolean }> =
        overflowEmails.map((email) => ({
          email,
          ok: false,
          skipped: true,
          error: "No available team slots",
        }));
      for (const item of results) {
        await options.onMemberProcessed?.(item);
      }
      if (acceptedEmails.length === 0) {
        return { owner: normalizedOwnerEmail, successCount: 0, failedCount: results.length, results };
      }
      let ownerAccessToken = owner.accessToken?.trim() ?? "";
      let ownerRefreshToken = owner.refreshToken?.trim() ?? "";
      if (!ownerAccessToken) {
        if (!ownerRefreshToken) throw new Error("Owner account has no usable access token");
        const refreshed = await deps.refreshAccessTokenByRefreshToken({
          refreshToken: ownerRefreshToken,
          userAgent: deps.authUserAgent,
        });
        ownerAccessToken = refreshed.accessToken;
        ownerRefreshToken = refreshed.refreshToken?.trim() || ownerRefreshToken;
      }
      if (!options.skipInvite) {
        await inviteMembersToTeam({
          ownerAccountId: owner.accountId,
          ownerAccessToken,
          memberEmails: acceptedEmails,
        });
      }
      for (const email of acceptedEmails) {
        try {
          await deps.reloginTeamAccount({
            email,
            targetAccountId: owner.accountId,
            ownerId: owner.id,
          });
          const item = { email, ok: true } as const;
          results.push(item);
          await options.onMemberProcessed?.(item);
        } catch (error) {
          const item = {
            email,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          results.push(item);
          await options.onMemberProcessed?.(item);
        }
      }
      const successCount = results.filter((item) => item.ok).length;
      console.info(
        `[team-join] join-done owner=${normalizedOwnerEmail} success=${successCount} failed=${results.length - successCount}`,
      );
      return {
        owner: normalizedOwnerEmail,
        successCount,
        failedCount: results.length - successCount,
        results,
      };
    });
  }

  async function joinMembersToAvailableTeams(options: {
    memberEmails: string[];
    ensureNotStopped?: () => void;
    onMemberProcessed?: (result: {
      email: string;
      ok: boolean;
      error?: string;
      skipped?: boolean;
      ownerEmail?: string;
    }) => void | Promise<void>;
  }) {
    const remainingEmails = Array.from(
      new Set(options.memberEmails.map((item) => item.trim().toLowerCase()).filter(Boolean)),
    );
    if (remainingEmails.length === 0) throw new Error("memberEmails is required");
    const availableOwners = await listAvailableTeamOwners();
    const results: Array<{
      email: string;
      ok: boolean;
      error?: string;
      skipped?: boolean;
      ownerEmail?: string;
    }> = [];
    for (const owner of availableOwners) {
      if (remainingEmails.length === 0) break;
      const batch = remainingEmails.slice(0, owner.availableSlots);
      if (batch.length === 0) continue;
      const joined = await joinMembersToOwnerTeam({
        ownerEmail: owner.email,
        memberEmails: batch,
        ensureNotStopped: options.ensureNotStopped,
        onMemberProcessed: async () => {
          options.ensureNotStopped?.();
        },
      });
      const joinedEmails = new Set(joined.results.filter((item) => item.ok).map((item) => item.email));
      for (const item of joined.results) {
        const resultItem = { ...item, ownerEmail: owner.email };
        results.push(resultItem);
        await options.onMemberProcessed?.(resultItem);
      }
      for (const email of batch) {
        const index = remainingEmails.indexOf(email);
        if (index >= 0) remainingEmails.splice(index, 1);
        if (!joinedEmails.has(email)) {
        }
      }
    }
    for (const email of remainingEmails) {
      const item = { email, ok: false, skipped: true, error: "No available team slots" };
      results.push(item);
      await options.onMemberProcessed?.(item);
    }
    const successCount = results.filter((item) => item.ok).length;
    return {
      successCount,
      failedCount: results.length - successCount,
      results,
    };
  }

  return {
    withTeamOwnerJoinLock,
    getTeamOwnerAvailableSlots,
    countPendingTeamInvites,
    getTeamOwnerEffectiveAvailableSlotsByEmail,
    listTeamOwnerMembersByEmail,
    inviteTeamOwnerMemberByEmail,
    removeTeamOwnerMemberByEmail,
    inviteMembersToTeam,
    revokeTeamInviteByEmail,
    listAvailableTeamOwners,
    joinMembersToOwnerTeam,
    joinMembersToAvailableTeams,
  };
}
