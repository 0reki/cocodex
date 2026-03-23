import type { TeamAccountRecord } from "@workspace/database";
import { createTeamAuthServices } from "./team-auth-services.ts";
import { createTeamJoinServices } from "./team-join-services.ts";
import { createTeamSignupServices } from "./team-signup-services.ts";

export function createTeamServices(deps: {
  authUserAgent: string;
  ownerSignupProxyUrl: string | null;
  teamOwnerMaxMembers: number;
  getSystemSettings: () => Promise<{
    ownerMailDomains?: unknown[] | null;
    cloudMailDomains?: unknown[] | null;
  } | null>;
  getOpenAIApiRuntimeConfig: () => Promise<{ userAgent: string }>;
  resolveRateLimitForAccount: (
    account: {
      email: string;
      accessToken: string | null;
      accountId: string | null;
      userId: string | null;
      proxyId?: string | null;
      rateLimit?: Record<string, unknown> | null;
    },
    runtimeConfig?: { userAgent: string },
  ) => Promise<Record<string, unknown> | null>;
  upsertTeamMemberAccount: (input: Record<string, unknown>) => Promise<unknown>;
  upsertTeamOwnerAccount: (input: Record<string, unknown>) => Promise<unknown>;
  listTeamOwnerAccountsPage: (
    page: number,
    pageSize: number,
  ) => Promise<{ items: TeamAccountRecord[] }>;
  getTeamAccountLoginByEmail: (email: string) => Promise<any>;
  getTeamOwnerAccountByEmail: (email: string) => Promise<any>;
  ensureDatabaseSchema: () => Promise<void>;
  refreshAccessTokenByRefreshTokenExternal?: (args: {
    refreshToken: string;
    userAgent?: string;
  }) => Promise<{ accessToken: string; refreshToken?: string | null }>;
}) {
  const {
    createCloudMailInbox,
    refreshAccessTokenByRefreshToken,
    createRandomDomainPicker,
    exchangeCodexRefreshToken,
    getOpenAIApiAccountHelpers,
    loadTeamAccountMetadata,
  } = createTeamAuthServices({
    authUserAgent: deps.authUserAgent,
    getSystemSettings: deps.getSystemSettings,
    refreshAccessTokenByRefreshTokenExternal:
      deps.refreshAccessTokenByRefreshTokenExternal,
  });

  async function reloginTeamAccount(
    input:
      | string
      | { email: string; targetAccountId?: string | null; ownerId?: string | null },
  ) {
    await deps.ensureDatabaseSchema();
    const options =
      typeof input === "string"
        ? { email: input, targetAccountId: null, ownerId: null }
        : input;
    const account = await deps.getTeamAccountLoginByEmail(options.email);
    if (!account) throw new Error("Team account not found");
    const password = account.password?.trim() ?? "";
    if (!password) throw new Error(`Team account ${account.email} has no stored password`);
    const codexAuth = await exchangeCodexRefreshToken({
      email: account.email,
      password,
      preferredWorkspaceId: options.targetAccountId ?? account.accountId,
    });
    const freshRefreshToken = codexAuth.refreshToken;
    const refreshed = await refreshAccessTokenByRefreshToken({
      refreshToken: freshRefreshToken,
      userAgent: deps.authUserAgent,
    });
    const accessToken = refreshed.accessToken;
    const refreshToken = refreshed.refreshToken?.trim() || freshRefreshToken;
    const metadata = await loadTeamAccountMetadata({
      accessToken,
      email: account.email,
      targetAccountId:
        options.targetAccountId ?? codexAuth.workspaceId ?? account.accountId,
      logPrefix: "team-relogin",
    });
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    const rateLimit = await deps.resolveRateLimitForAccount(
      {
        email: account.email,
        accessToken,
        accountId: metadata.accountId ?? account.accountId,
        userId: metadata.userId ?? account.userId,
        proxyId: account.proxyId ?? null,
        rateLimit: null,
      },
      runtimeConfig,
    );
    const upsertInput = {
      email: account.email,
      userId: metadata.userId ?? account.userId,
      portalUserId: account.portalUserId,
      ownerId: options.ownerId ?? account.ownerId,
      name: metadata.name ?? account.name,
      accountId: metadata.accountId ?? account.accountId,
      workspaceName: metadata.workspaceName,
      planType: metadata.planType ?? account.planType,
      teamMemberCount: metadata.teamMemberCount,
      teamExpiresAt: metadata.teamExpiresAt ?? account.teamExpiresAt,
      workspaceIsDeactivated:
        metadata.workspaceIsDeactivated ?? account.workspaceIsDeactivated,
      workspaceCancelledAt: metadata.workspaceCancelledAt,
      status:
        metadata.workspaceIsDeactivated === true
          ? "disabled"
          : account.status ?? "active",
      proxyId: account.proxyId,
      accessToken,
      refreshToken,
      password,
      systemCreated: account.systemCreated,
      type: account.type,
      cooldownUntil: account.cooldownUntil,
      rateLimit,
    };
    if (account.accountUserRole === "account-owner") {
      return deps.upsertTeamOwnerAccount(upsertInput);
    }
    if (account.accountUserRole === "standard-user") {
      return deps.upsertTeamMemberAccount(upsertInput);
    }
    throw new Error(`Unsupported team account role: ${account.accountUserRole ?? "unknown"}`);
  }

  const {
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
  } = createTeamJoinServices({
    teamOwnerMaxMembers: deps.teamOwnerMaxMembers,
    authUserAgent: deps.authUserAgent,
    listTeamOwnerAccountsPage: deps.listTeamOwnerAccountsPage,
    getTeamOwnerAccountByEmail: deps.getTeamOwnerAccountByEmail,
    refreshAccessTokenByRefreshToken,
    reloginTeamAccount,
  });

  const {
    runTeamMemberSignupBatch,
    runTeamOwnerSignupBatch,
  } = createTeamSignupServices({
    ownerSignupProxyUrl: deps.ownerSignupProxyUrl,
    teamOwnerMaxMembers: deps.teamOwnerMaxMembers,
    getOpenAIApiRuntimeConfig: deps.getOpenAIApiRuntimeConfig,
    resolveRateLimitForAccount: deps.resolveRateLimitForAccount,
    upsertTeamMemberAccount: deps.upsertTeamMemberAccount,
    upsertTeamOwnerAccount: deps.upsertTeamOwnerAccount,
    getTeamOwnerAccountByEmail: deps.getTeamOwnerAccountByEmail,
    createRandomDomainPicker,
    countPendingTeamInvites,
    inviteMembersToTeam,
    revokeTeamInviteByEmail,
    refreshAccessTokenByRefreshToken,
    exchangeCodexRefreshToken,
    createCloudMailInbox,
  });

  return {
    exchangeCodexRefreshToken,
    runTeamMemberSignupBatch,
    runTeamOwnerSignupBatch,
    refreshAccessTokenByRefreshToken,
    getOpenAIApiAccountHelpers,
    loadTeamAccountMetadata,
    reloginTeamAccount,
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
