import { CloudMailClient, createReadableCloudMailAddress } from "@workspace/cloud-mail";
import * as openaiApiModule from "@workspace/openai-api";
import { getTeamMemberAccountByEmail } from "@workspace/database";
import * as signupModule from "@workspace/openai-signup";

const TEAM_SIGNUP_DEFAULT_TIMEOUT_MS = Math.max(
  5_000,
  Math.trunc(Number(process.env.TEAM_SIGNUP_DEFAULT_TIMEOUT_MS ?? 30_000)),
);
const TEAM_SIGNUP_SAVE_TIMEOUT_MS = Math.max(
  5_000,
  Math.trunc(Number(process.env.TEAM_SIGNUP_SAVE_TIMEOUT_MS ?? 45_000)),
);

async function withTimeout<T>(label: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

type SignupFlowAccount = {
  email: string;
  password: string;
  userId: string | null;
  name: string | null;
  accountId: string | null;
  workspaceName: string | null;
  planType: string | null;
  workspaceIsDeactivated: boolean;
  workspaceCancelledAt: string | null;
  accessToken: string;
  type?: string | null;
  proxyId?: string | null;
  rateLimit?: Record<string, unknown> | null;
};

type SignupBatchResult = {
  successCount?: number;
  failedCount?: number;
};

type TeamMemberSignupExecutionResult = {
  flowResult: SignupBatchResult;
  invitedCount: number;
  createdCount: number;
  failedCount: number;
  saveFailures: string[];
  createdEmails: string[];
};

type TeamOwnerSignupExecutionResult = TeamMemberSignupExecutionResult;

export function createTeamSignupServices(deps: {
  ownerSignupProxyUrl: string | null;
  teamOwnerMaxMembers: number;
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
  getTeamOwnerAccountByEmail: (email: string) => Promise<any>;
  createRandomDomainPicker: (domains: string[]) => () => string;
  countPendingTeamInvites: (options: {
    ownerAccountId: string;
    ownerAccessToken: string;
  }) => Promise<number>;
  inviteMembersToTeam: (options: {
    ownerAccountId: string;
    ownerAccessToken: string;
    memberEmails: string[];
  }) => Promise<unknown>;
  revokeTeamInviteByEmail: (options: {
    ownerAccountId: string;
    ownerAccessToken: string;
    email: string;
  }) => Promise<unknown>;
  refreshAccessTokenByRefreshToken: (args: {
    refreshToken: string;
    userAgent?: string;
  }) => Promise<{ accessToken: string; refreshToken?: string | null }>;
  exchangeCodexRefreshToken: (options: {
    email: string;
    password: string;
    ensureNotStopped?: () => void;
    preferredWorkspaceId?: string | null;
  }) => Promise<{ refreshToken: string; workspaceId: string | null }>;
  createCloudMailInbox: () => {
    initialize(email: string): Promise<void>;
    snapshot(email: string): Promise<{ fingerprints: Set<string> }>;
    waitForOtp(
      email: string,
      timeoutMs?: number,
      pollIntervalMs?: number,
      snapshot?: { fingerprints: Set<string> },
    ): Promise<string>;
  };
}) {
  async function runTeamMemberSignupBatch(options: {
    count: number;
    concurrency: number;
    domains: string[];
    ownerEmail?: string;
    portalUserId?: string;
    ensureNotStopped?: () => void;
    onAccountSaved?: (savedCount: number) => void | Promise<void>;
  }): Promise<TeamMemberSignupExecutionResult> {
    const domains = options.domains.map((item) => item.trim()).filter(Boolean);
    if (domains.length === 0) {
      throw new Error("No cloud-mail domains configured in system settings");
    }
    const cloudMail = new CloudMailClient();
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    const nextDomain = deps.createRandomDomainPicker(domains);
    let createdCount = 0;
    let invitedCount = 0;
    const createdEmails: string[] = [];
    const saveFailures: string[] = [];
    let ownerContext: {
      workspaceName: string | null;
      planType: string | null;
      teamMemberCount: number | null;
      teamExpiresAt: string | Date | null;
    } | null = null;
    let ownerInviteContext: {
      ownerEmail: string;
      ownerAccountId: string;
      ownerAccessToken: string;
    } | null = null;
    const managedInvitedEmails = new Set<string>();
    const mailInboxState = new Map<
      string,
      { createdAfterMs: number; minEmailId: number }
    >();
    const createCloudMailAddress = (domain: string) =>
      createReadableCloudMailAddress(domain);
    const initializeCloudMailAddress = async (email: string) => {
      await withTimeout(
        `cloud mail createAccount ${email}`,
        TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
        () => cloudMail.createAccount(email),
      );
      let minEmailId = 0;
      try {
        minEmailId = await withTimeout(
          `cloud mail getMaxEmailId ${email}`,
          TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
          () => cloudMail.getMaxEmailId(email),
        );
      } catch {
        minEmailId = 0;
      }
      mailInboxState.set(email, { createdAfterMs: Date.now(), minEmailId });
    };
    const createAndMaybeInviteEmail = async () => {
      const email = createCloudMailAddress(nextDomain());
      await initializeCloudMailAddress(email);
      managedInvitedEmails.add(email);
      if (ownerInviteContext) {
        const inviteContext = ownerInviteContext;
        console.info(
          `[team-signup] fill-members owner=${inviteContext.ownerEmail} invite-replacement-start email=${email}`,
        );
        await withTimeout(
          `invite replacement member ${email}`,
          TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
          () =>
            deps.inviteMembersToTeam({
              ownerAccountId: inviteContext.ownerAccountId,
              ownerAccessToken: inviteContext.ownerAccessToken,
              memberEmails: [email],
            }),
        );
        invitedCount += 1;
        console.info(
          `[team-signup] fill-members owner=${inviteContext.ownerEmail} invite-replacement-done email=${email}`,
        );
      }
      return email;
    };
    const proxyPool = deps.ownerSignupProxyUrl ? [deps.ownerSignupProxyUrl] : [];
    const preparedEmails: string[] = [];

    if (options.ownerEmail) {
      const ownerEmail = options.ownerEmail.trim().toLowerCase();
      console.info(
        `[team-signup] fill-members bootstrap owner=${ownerEmail} requested=${options.count} concurrency=${options.concurrency}`,
      );
      const owner = await withTimeout(
        `load team owner ${ownerEmail}`,
        TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
        () => deps.getTeamOwnerAccountByEmail(ownerEmail),
      );
      if (!owner) {
        throw new Error("Owner account not found");
      }
      if (owner.planType !== "team") {
        throw new Error("Owner account is not on team plan");
      }
      if (!owner.accountId) {
        throw new Error("Owner account is missing accountId");
      }
      const availableSlots = Math.max(
        0,
        deps.teamOwnerMaxMembers - Math.max(0, owner.teamMemberCount ?? 0),
      );
      ownerContext = {
        workspaceName: owner.workspaceName ?? null,
        planType: owner.planType ?? "team",
        teamMemberCount: owner.teamMemberCount ?? null,
        teamExpiresAt: owner.teamExpiresAt ?? null,
      };
      let ownerAccessToken = owner.accessToken?.trim() ?? "";
      const ownerRefreshToken = owner.refreshToken?.trim() ?? "";
      if (!ownerAccessToken) {
        if (!ownerRefreshToken) {
          throw new Error("Owner account has no usable access token");
        }
        const refreshed = await withTimeout(
          `refresh owner access token ${owner.email}`,
          TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
          () =>
            deps.refreshAccessTokenByRefreshToken({
              refreshToken: ownerRefreshToken,
              userAgent: runtimeConfig.userAgent,
            }),
        );
        ownerAccessToken = refreshed.accessToken;
      }
      const pendingInvites = await deps.countPendingTeamInvites({
        ownerAccountId: owner.accountId,
        ownerAccessToken,
      });
      const effectiveAvailableSlots = Math.max(0, availableSlots - pendingInvites);
      const inviteCount = Math.min(options.count, effectiveAvailableSlots);
      console.info(
        `[team-signup] fill-members owner=${owner.email} currentMembers=${owner.teamMemberCount ?? 0} pendingInvites=${pendingInvites} availableSlots=${effectiveAvailableSlots} inviteCount=${inviteCount}`,
      );
      if (inviteCount <= 0) {
        throw new Error("Owner account has no available team slots");
      }

      for (let index = preparedEmails.length; index < inviteCount; index += 1) {
        options.ensureNotStopped?.();
        const email = createCloudMailAddress(nextDomain());
        await initializeCloudMailAddress(email);
        managedInvitedEmails.add(email);
        preparedEmails.push(email);
      }
      ownerInviteContext = {
        ownerEmail: owner.email,
        ownerAccountId: owner.accountId,
        ownerAccessToken,
      };

      console.info(
        `[team-signup] fill-members owner=${owner.email} invite-start count=${preparedEmails.length}`,
      );
      await withTimeout(
        `invite initial members for ${owner.email}`,
        TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
        () =>
          deps.inviteMembersToTeam({
            ownerAccountId: owner.accountId,
            ownerAccessToken,
            memberEmails: preparedEmails,
          }),
      );
      invitedCount = preparedEmails.length;
      console.info(
        `[team-signup] fill-members owner=${owner.email} invite-done count=${invitedCount}`,
      );
    }

    const mailProvider = {
      generateEmail: async () => {
        const prepared = preparedEmails.shift();
        if (prepared) {
          return prepared;
        }
        return createAndMaybeInviteEmail();
      },
      waitForOtp: async (email: string, timeoutMs?: number, pollIntervalMs?: number) =>
        cloudMail.waitForOpenAiOtp({
          accountEmail: email,
          toEmail: email,
          timeoutMs,
          pollIntervalMs,
          senderContains: "openai",
          subjectIncludes: ["chatgpt", "openai", "code", "验证码", "代码"],
          minEmailId: mailInboxState.get(email)?.minEmailId,
          createdAfterMs: mailInboxState.get(email)?.createdAfterMs,
        }),
      prepareForRetry: async (email: string) => {
        let minEmailId = 0;
        try {
          minEmailId = await cloudMail.getMaxEmailId(email);
        } catch {
          minEmailId = 0;
        }
        mailInboxState.set(email, { createdAfterMs: Date.now(), minEmailId });
      },
      abandonEmail: async (email: string, reason: string) => {
        if (!ownerInviteContext) return;
        const normalizedEmail = email.trim().toLowerCase();
        if (!managedInvitedEmails.has(normalizedEmail)) {
          console.warn(
            `[team-signup] fill-members owner=${ownerInviteContext.ownerEmail} skip-abandon-cleanup email=${normalizedEmail} reason=${reason} managed=false`,
          );
          return;
        }
        console.warn(
          `[team-signup] fill-members owner=${ownerInviteContext.ownerEmail} abandon-email email=${normalizedEmail} reason=${reason}`,
        );
        const canManageTeamUsers =
          typeof openaiApiModule.listAccountUsers === "function" &&
          typeof openaiApiModule.deleteAccountUser === "function";
        let removedFromTeam = false;
        if (canManageTeamUsers) {
          try {
            const usersPayload = (await withTimeout(
              `list account users ${normalizedEmail}`,
              TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
              () =>
                openaiApiModule.listAccountUsers({
                  accessToken: ownerInviteContext.ownerAccessToken,
                  accountId: ownerInviteContext.ownerAccountId,
                  limit: 25,
                  offset: 0,
                  query: "",
                  userAgent: runtimeConfig.userAgent,
                }),
            )) as { items?: Array<{ email?: string | null; id?: string | null }> };
            const matchedUser =
              (Array.isArray(usersPayload?.items) ? usersPayload.items : []).find(
                (item: { email?: string | null; id?: string | null }) =>
                  item.email?.trim().toLowerCase() === normalizedEmail &&
                  typeof item.id === "string" &&
                  item.id.trim().length > 0,
              ) ?? null;
            if (matchedUser?.id) {
              const matchedUserId = matchedUser.id.trim();
              await withTimeout(
                `delete account user ${normalizedEmail}`,
                TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
                () =>
                  openaiApiModule.deleteAccountUser({
                    accessToken: ownerInviteContext.ownerAccessToken,
                    accountId: ownerInviteContext.ownerAccountId,
                    userId: matchedUserId,
                    userAgent: runtimeConfig.userAgent,
                  }),
              );
              removedFromTeam = true;
              console.info(
                `[team-signup] fill-members owner=${ownerInviteContext.ownerEmail} team-user-removed email=${normalizedEmail} userId=${matchedUserId}`,
              );
            }
          } catch (error) {
            console.warn(
              `[team-signup] fill-members owner=${ownerInviteContext.ownerEmail} team-user-remove-check-failed email=${normalizedEmail}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (!removedFromTeam) {
          await withTimeout(
            `revoke invite ${normalizedEmail}`,
            TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
            () =>
              deps.revokeTeamInviteByEmail({
                ownerAccountId: ownerInviteContext.ownerAccountId,
                ownerAccessToken: ownerInviteContext.ownerAccessToken,
                email: normalizedEmail,
              }),
          );
        }
        managedInvitedEmails.delete(normalizedEmail);
        mailInboxState.delete(normalizedEmail);
      },
    };
    const persistAccount = async (account: SignupFlowAccount) => {
      try {
        console.info(`[team-signup] persist start email=${account.email}`);
        console.info(`[team-signup] persist rate-limit-start email=${account.email}`);
        const rateLimit = await withTimeout(
          `resolve rate limit ${account.email}`,
          TEAM_SIGNUP_SAVE_TIMEOUT_MS,
          () => deps.resolveRateLimitForAccount(account, runtimeConfig),
        );
        console.info(`[team-signup] persist rate-limit-done email=${account.email}`);
        let refreshToken: string | null = null;
        try {
          console.info(`[team-signup] persist codex-refresh-start email=${account.email}`);
          const codexAuth = await withTimeout(
            `exchange codex refresh token ${account.email}`,
            TEAM_SIGNUP_SAVE_TIMEOUT_MS,
            () =>
              deps.exchangeCodexRefreshToken({
                email: account.email,
                password: account.password,
                ensureNotStopped: options.ensureNotStopped,
              }),
          );
          refreshToken = codexAuth.refreshToken;
          console.info(`[team-signup] persist codex-refresh-done email=${account.email}`);
        } catch (error) {
          console.warn(
            `[team-signup] codex refresh bootstrap failed for ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        console.info(`[team-signup] persist upsert-start email=${account.email}`);
        await withTimeout(`upsert team member ${account.email}`, TEAM_SIGNUP_SAVE_TIMEOUT_MS, () =>
          deps.upsertTeamMemberAccount({
            email: account.email,
            userId: account.userId,
            portalUserId: options.portalUserId ?? null,
            name: account.name,
            accountId: account.accountId,
            workspaceName: ownerContext?.workspaceName ?? account.workspaceName,
            planType: ownerContext?.planType ?? account.planType,
            teamMemberCount: ownerContext?.teamMemberCount ?? null,
            teamExpiresAt: ownerContext?.teamExpiresAt ?? null,
            workspaceIsDeactivated: account.workspaceIsDeactivated,
            workspaceCancelledAt: account.workspaceCancelledAt,
            status: account.workspaceIsDeactivated ? "disabled" : "active",
            accessToken: account.accessToken,
            refreshToken,
            password: account.password,
            systemCreated: true,
            type: account.type,
            rateLimit,
          }),
        );
        console.info(`[team-signup] persist upsert-done email=${account.email}`);
        createdCount += 1;
        createdEmails.push(account.email);
        console.info(
          `[team-signup] persist saved email=${account.email} createdCount=${createdCount}`,
        );
        await withTimeout(
          `update task savedCount ${account.email}`,
          TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
          async () => {
            await options.onAccountSaved?.(createdCount);
          },
        );
        console.info(
          `[team-signup] persist on-account-saved-done email=${account.email} createdCount=${createdCount}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[team-signup] save team member failed for ${account.email}: ${message}`);
        saveFailures.push(message);
      }
    };
    const cleanupManagedTeamMembersMissingFromDatabase = async (
      candidateEmails: Iterable<string>,
      reason: "managed-invite" | "created-email-recheck",
    ) => {
      if (!ownerInviteContext) {
        return;
      }
      const normalizedCandidates = Array.from(
        new Set(
          Array.from(candidateEmails)
            .map((item) => item.trim().toLowerCase())
            .filter((item) => item.length > 0),
        ),
      );
      if (normalizedCandidates.length === 0) {
        return;
      }
      if (
        typeof openaiApiModule.listAccountUsers !== "function" ||
        typeof openaiApiModule.deleteAccountUser !== "function" ||
        typeof getTeamMemberAccountByEmail !== "function"
      ) {
        return;
      }

      const usersPayload = (await withTimeout(
        `list account users ${ownerInviteContext.ownerEmail}`,
        TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
        () =>
          openaiApiModule.listAccountUsers({
            accessToken: ownerInviteContext.ownerAccessToken,
            accountId: ownerInviteContext.ownerAccountId,
            limit: 25,
            offset: 0,
            query: "",
            userAgent: runtimeConfig.userAgent,
          }),
      )) as { items?: Array<{ email?: string | null; id?: string | null }> };
      const teamUsersByEmail = new Map<string, string>();
      for (const item of Array.isArray(usersPayload.items) ? usersPayload.items : []) {
        const email = item.email?.trim().toLowerCase() ?? "";
        const userId = item.id?.trim() ?? "";
        if (!email || !userId) continue;
        teamUsersByEmail.set(email, userId);
      }

      for (const email of normalizedCandidates) {
        const existing = await withTimeout(
          `load team member db record ${email}`,
          TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
          () => getTeamMemberAccountByEmail(email),
        );
        if (existing) {
          continue;
        }
        const userId = teamUsersByEmail.get(email) ?? "";
        if (!userId) {
          continue;
        }
        await withTimeout(
          `delete orphan team member ${email}`,
          TEAM_SIGNUP_DEFAULT_TIMEOUT_MS,
          () =>
            openaiApiModule.deleteAccountUser({
              accessToken: ownerInviteContext.ownerAccessToken,
              accountId: ownerInviteContext.ownerAccountId,
              userId,
              userAgent: runtimeConfig.userAgent,
            }),
        );
        managedInvitedEmails.delete(email);
        mailInboxState.delete(email);
        console.warn(
          `[team-signup] fill-members owner=${ownerInviteContext.ownerEmail} cleanup-missing-db-team-member email=${email} userId=${userId} reason=${reason}`,
        );
      }
    };
    const flowResult = (await signupModule.runSignupBatch({
      count: options.ownerEmail ? Math.max(1, invitedCount) : options.count,
      concurrency: Math.max(1, Math.min(options.concurrency, options.count)),
      proxyPool,
      includeResults: false,
      mailProvider,
      onResult: async (result: { ok?: boolean; account?: SignupFlowAccount }) => {
        if (result?.ok && result.account) {
          await persistAccount(result.account);
        }
      },
    })) as SignupBatchResult;
    await cleanupManagedTeamMembersMissingFromDatabase(
      managedInvitedEmails,
      "managed-invite",
    );
    await cleanupManagedTeamMembersMissingFromDatabase(
      createdEmails,
      "created-email-recheck",
    );
    const signupSuccessCount =
      flowResult.successCount ??
      Math.max(0, options.count - (flowResult.failedCount ?? 0));
    const signupFailedCount =
      flowResult.failedCount ?? Math.max(0, options.count - signupSuccessCount);
    console.info(
      `[team-signup] signup-batch finished owner=${options.ownerEmail?.trim().toLowerCase() ?? "<none>"} invited=${invitedCount} created=${createdCount} signupSuccess=${signupSuccessCount} signupFailed=${signupFailedCount} saveFailures=${saveFailures.length}`,
    );
    return {
      flowResult,
      invitedCount,
      createdCount,
      failedCount: signupFailedCount + saveFailures.length,
      saveFailures,
      createdEmails,
    };
  }

  async function runTeamOwnerSignupBatch(options: {
    count: number;
    concurrency: number;
    domains: string[];
    ensureNotStopped?: () => void;
    onAccountSaved?: (savedCount: number) => void | Promise<void>;
  }): Promise<TeamOwnerSignupExecutionResult> {
    const domains = options.domains.map((item) => item.trim()).filter(Boolean);
    if (domains.length === 0) {
      throw new Error("No owner mail domains configured in system settings");
    }
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    const nextDomain = deps.createRandomDomainPicker(domains);
    let createdCount = 0;
    const saveFailures: string[] = [];
    const inboxes = new Map<
      string,
      ReturnType<typeof deps.createCloudMailInbox>
    >();
    const createOwnerAddress = (domain: string) =>
      createReadableCloudMailAddress(domain);
    const mailProvider = {
      generateEmail: async () => {
        const email = createOwnerAddress(nextDomain());
        const inbox = deps.createCloudMailInbox();
        await inbox.initialize(email);
        inboxes.set(email, inbox);
        return email;
      },
      waitForOtp: async (email: string, timeoutMs?: number, pollIntervalMs?: number) => {
        let inbox = inboxes.get(email);
        if (!inbox) {
          inbox = deps.createCloudMailInbox();
          await inbox.initialize(email);
          inboxes.set(email, inbox);
        }
        return inbox.waitForOtp(email, timeoutMs, pollIntervalMs);
      },
    };
    const persistAccount = async (account: SignupFlowAccount) => {
      try {
        const rateLimit = await deps.resolveRateLimitForAccount(account, runtimeConfig);
        let refreshToken: string | null = null;
        try {
          const codexAuth = await deps.exchangeCodexRefreshToken({
            email: account.email,
            password: account.password,
            ensureNotStopped: options.ensureNotStopped,
          });
          refreshToken = codexAuth.refreshToken;
        } catch (error) {
          console.warn(
            `[team-signup] codex refresh bootstrap failed for owner ${account.email}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await deps.upsertTeamOwnerAccount({
          email: account.email,
          userId: account.userId,
          name: account.name,
          accountId: account.accountId,
          workspaceName: account.workspaceName,
          planType: account.planType,
          teamMemberCount: null,
          workspaceIsDeactivated: account.workspaceIsDeactivated,
          workspaceCancelledAt: account.workspaceCancelledAt,
          status: account.workspaceIsDeactivated ? "disabled" : "active",
          accessToken: account.accessToken,
          refreshToken,
          password: account.password,
          systemCreated: true,
          type: account.type,
          rateLimit,
        });
        createdCount += 1;
        await options.onAccountSaved?.(createdCount);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[team-signup] save team owner failed for ${account.email}: ${message}`);
        saveFailures.push(message);
      }
    };
    const flowResult = (await signupModule.runSignupBatch({
      count: options.count,
      concurrency: Math.max(1, Math.min(options.concurrency, options.count)),
      includeResults: false,
      mailProvider,
      onResult: async (result: { ok?: boolean; account?: SignupFlowAccount }) => {
        if (result?.ok && result.account) {
          await persistAccount(result.account);
        }
      },
    })) as SignupBatchResult;
    const signupSuccessCount =
      flowResult.successCount ??
      Math.max(0, options.count - (flowResult.failedCount ?? 0));
    const signupFailedCount =
      flowResult.failedCount ?? Math.max(0, options.count - signupSuccessCount);
    return {
      flowResult,
      invitedCount: 0,
      createdCount,
      failedCount: signupFailedCount + saveFailures.length,
      saveFailures,
      createdEmails: [],
    };
  }

  return {
    runTeamMemberSignupBatch,
    runTeamOwnerSignupBatch,
  };
}
