import os from "node:os";
import * as signupModule from "@workspace/openai-signup";

import {
  type SignupBatchResult,
  type SignupFlowAccount,
  type SignupFlowResult,
  type SignupTask,
  type SignupTaskControlStatus,
  type SignupTaskKind,
  type SignupTaskState,
  type TeamMemberSignupExecutionResult,
  type TeamOwnerSignupExecutionResult,
  isRecord,
  summarizeSignupResult,
} from "./types.ts";
import {
  translateMessagesInParallel,
  type TranslationAccount,
} from "@workspace/inbox-translation";

const SIGNUP_TASKS_IN_MEMORY_MAX = Math.max(
  50,
  Number(process.env.SIGNUP_TASKS_IN_MEMORY_MAX ?? 200),
);

const state: SignupTaskState = {
  tasks: new Map<string, SignupTask>(),
  queue: [],
  control: new Map(),
  scheduler: {
    runningWorkers: 0,
    maxWorkers: Number.MAX_SAFE_INTEGER,
  },
};

type TaskNotificationLocale =
  | "de-DE"
  | "en-US"
  | "es-ES"
  | "fr-FR"
  | "it-IT"
  | "ja-JP"
  | "ko-KR"
  | "pt-BR"
  | "ru-RU"
  | "tr-TR"
  | "zh-CN"
  | "zh-HK"
  | "zh-MO"
  | "zh-TW";

const DEFAULT_OPENAI_API_USER_AGENT = "node/22.14.0";
const DEFAULT_OPENAI_API_CLIENT_VERSION =
  process.env.CODEX_CLIENT_VERSION?.trim() || "0.98.0";

function resolveTaskNotificationLocale(
  country: string | null | undefined,
): TaskNotificationLocale {
  const normalized = (country ?? "").trim().toUpperCase();
  if (normalized === "CN") return "zh-CN";
  if (normalized === "HK") return "zh-HK";
  if (normalized === "MO") return "zh-MO";
  if (normalized === "TW") return "zh-TW";
  if (normalized === "JP") return "ja-JP";
  if (normalized === "ES") return "es-ES";
  if (normalized === "FR") return "fr-FR";
  if (normalized === "DE") return "de-DE";
  if (normalized === "KR") return "ko-KR";
  if (normalized === "BR") return "pt-BR";
  if (normalized === "IT") return "it-IT";
  if (normalized === "RU") return "ru-RU";
  if (normalized === "TR") return "tr-TR";
  return "en-US";
}

function formatTaskDuration(durationMs: number | null) {
  if (durationMs == null || !Number.isFinite(durationMs)) return "-";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

function extractTaskResultSummary(task: SignupTask): {
  failedCount: number;
  successCount: number;
} {
  const result = isRecord(task.result)
    ? (task.result as Record<string, unknown>)
    : null;
  const failedCountValue = result?.["failedCount"];
  const successCountValue = result?.["successCount"];
  return {
    failedCount:
      typeof failedCountValue === "number" && Number.isFinite(failedCountValue)
        ? Math.max(0, Math.floor(failedCountValue))
        : 0,
    successCount:
      typeof successCountValue === "number" && Number.isFinite(successCountValue)
        ? Math.max(0, Math.floor(successCountValue))
        : task.savedCount,
  };
}

function buildUserFacingTaskError(task: SignupTask): string | null {
  if (task.status === "completed") return null;

  const genericByKind: Record<SignupTaskKind, string> = {
    openai: "The signup task did not complete successfully.",
    "team-member": "The team member signup task did not complete successfully.",
    "team-member-fill":
      "The fill-members task did not complete successfully.",
    "team-member-join":
      "The team member join task did not complete successfully.",
    "team-owner": "The team owner signup task did not complete successfully.",
  };

  return genericByKind[task.kind];
}

function buildSignupTaskNotification(task: SignupTask): { title: string; body: string } {
  const status = task.status;
  const savedSummary = `${task.savedCount}/${task.count}`;
  const duration = formatTaskDuration(task.durationMs);
  const { failedCount } = extractTaskResultSummary(task);
  const userFacingError = buildUserFacingTaskError(task);
  const taskType: Record<SignupTaskKind, string> = {
    openai: "OpenAI signup",
    "team-member": "team member signup",
    "team-member-fill": "team member fill",
    "team-member-join": "team member join",
    "team-owner": "team owner signup",
  };
  const title =
    status === "completed"
      ? "Task completed"
      : status === "failed"
        ? "Task failed"
        : "Task stopped";
  return {
    title,
    body:
      `Your ${taskType[task.kind]} task has finished.\n` +
      `Task ID: ${task.id}\n` +
      `Status: ${status}\n` +
      `Saved: ${savedSummary}\n` +
      `Duration: ${duration}` +
      (failedCount > 0 ? `\nFailed: ${failedCount}` : "") +
      (userFacingError ? `\nNotice: ${userFacingError}` : ""),
  };
}

async function notifySignupTaskCompletion(task: SignupTask, deps: any) {
  if (!isSignupTaskTerminal(task.status)) return;
  const requesterUserId = state.control.get(task.id)?.requesterUserId?.trim();
  if (!requesterUserId) return;

  try {
    await deps.ensureDatabaseSchema();
    const requester = await deps.getPortalUserById(requesterUserId);
    if (!requester || requester.enabled === false) return;

    const locale = resolveTaskNotificationLocale(requester.country ?? null);
    const englishNotification = buildSignupTaskNotification(task);
    let notification = {
      ...englishNotification,
      aiTranslated: false,
    };
    if (locale !== "en-US") {
      try {
        const settings = await deps.getSystemSettings();
        const translationModel = settings?.inboxTranslationModel?.trim() ?? "";
        if (translationModel) {
          const accounts = (await deps.listOpenAIAccountsForModelCache(8))
            .filter(
              (item: { id?: unknown; accessToken?: unknown }) =>
                typeof item.id === "string" &&
                typeof item.accessToken === "string" &&
                item.accessToken.trim().length > 0,
            )
            .map((item: { id: string; accessToken: string }) => ({
              id: item.id,
              accessToken: item.accessToken.trim(),
            }));
          if (accounts.length > 0) {
            const translations = await translateMessagesInParallel({
              title: englishNotification.title,
              body: englishNotification.body,
              locales: [locale],
              model: translationModel,
              userAgent:
                settings?.openaiApiUserAgent?.trim() ||
                DEFAULT_OPENAI_API_USER_AGENT,
              clientVersion:
                settings?.openaiClientVersion?.trim() ||
                DEFAULT_OPENAI_API_CLIENT_VERSION,
              accounts: accounts as TranslationAccount[],
            });
            const translated = translations[locale];
            if (translated?.title?.trim() || translated?.body?.trim()) {
              notification = {
                title: translated?.title?.trim() || englishNotification.title,
                body: translated?.body?.trim() || englishNotification.body,
                aiTranslated: true,
              };
            }
          }
        }
      } catch (error) {
        console.warn(
          `[signup] translate task ${task.id} locale=${locale} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await deps.createPortalInboxMessages({
      recipientUserIds: [requesterUserId],
      title: notification.title,
      body: notification.body,
      aiTranslated: notification.aiTranslated,
    });
  } catch (error) {
    console.warn(
      `[signup] notify task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function persistTerminalSignupTask(task: SignupTask, deps: any) {
  await persistSignupTask(task, deps);
  await notifySignupTaskCompletion(task, deps);
}

export function resolveSignupTaskKindFromResult(result: unknown): SignupTaskKind {
  if (isRecord(result) && result.kind === "team-member") return "team-member";
  if (isRecord(result) && result.kind === "team-member-fill") return "team-member-fill";
  if (isRecord(result) && result.kind === "team-member-join") {
    return "team-member-join";
  }
  if (isRecord(result) && result.kind === "team-owner") return "team-owner";
  return "openai";
}

export function toTaskView(task: SignupTask) {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    count: task.count,
    concurrency: task.concurrency,
    cpuMaxConcurrency: task.cpuMaxConcurrency,
    proxyPoolSize: task.proxyPoolSize,
    savedCount: task.savedCount,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
    error: task.error,
    result: summarizeSignupResult(task.result),
  };
}

function pruneSignupTasksInMemory() {
  if (state.tasks.size <= SIGNUP_TASKS_IN_MEMORY_MAX) return;
  const terminalTasks = Array.from(state.tasks.values())
    .filter((task) => isSignupTaskTerminal(task.status))
    .sort((a, b) => {
      const aMs = Date.parse(a.createdAt);
      const bMs = Date.parse(b.createdAt);
      return (Number.isFinite(aMs) ? aMs : 0) - (Number.isFinite(bMs) ? bMs : 0);
    });

  for (const task of terminalTasks) {
    if (state.tasks.size <= SIGNUP_TASKS_IN_MEMORY_MAX) break;
    state.control.delete(task.id);
    state.tasks.delete(task.id);
  }
}

export async function persistSignupTask(task: SignupTask, deps: any) {
  try {
    await deps.upsertSignupTask({
      id: task.id,
      kind: task.kind,
      status: task.status,
      count: task.count,
      concurrency: task.concurrency,
      cpuMaxConcurrency: task.cpuMaxConcurrency,
      proxyPoolSize: task.proxyPoolSize,
      savedCount: task.savedCount,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      durationMs: task.durationMs,
      error: task.error,
      result:
        ((summarizeSignupResult(task.result) as Record<string, unknown> | null) ??
          { kind: task.kind }) as Record<string, unknown> | null,
    });
  } catch (error) {
    console.warn(
      `[signup] persist task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function removeSignupTaskFromQueue(taskId: string) {
  const index = state.queue.indexOf(taskId);
  if (index >= 0) state.queue.splice(index, 1);
}

export function isSignupTaskTerminal(status: SignupTaskControlStatus) {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function isOpenAISignupTaskKind(kind: SignupTaskKind) {
  return (
    kind === "openai" ||
    kind === "team-member" ||
    kind === "team-member-fill" ||
    kind === "team-member-join" ||
    kind === "team-owner"
  );
}

export function getSignupMaxCount() {
  return Math.max(
    1,
    Number.isFinite(Number(process.env.OPENAI_SIGNUP_MAX_COUNT))
      ? Math.floor(Number(process.env.OPENAI_SIGNUP_MAX_COUNT))
      : 1000,
  );
}

function createCpuMaxConcurrency() {
  return Math.max(
    1,
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length,
  );
}

export function createSchedulerView() {
  return {
    runningWorkers: state.scheduler.runningWorkers,
    maxWorkers: state.scheduler.maxWorkers,
    queuedTasks: state.queue.length,
  };
}

export function createPendingTask(
  kind: SignupTaskKind,
  count: number,
  concurrency: number,
  proxyPoolSize: number,
): SignupTask {
  return {
    id: crypto.randomUUID(),
    kind,
    status: "pending",
    count,
    concurrency,
    cpuMaxConcurrency: createCpuMaxConcurrency(),
    proxyPoolSize,
    savedCount: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    result: kind === "openai" ? null : { kind },
    error: null,
  };
}

async function executeSignupTask(taskId: string, deps: any) {
  const task = state.tasks.get(taskId);
  if (!task) return;
  const control = state.control.get(taskId);
  if (!control) return;
  if (task.status !== "pending") return;

  const startedAt = Date.now();
  task.status = "running";
  task.startedAt = new Date().toISOString();
  task.finishedAt = null;
  task.durationMs = null;
  task.error = null;
  console.info(
    `[signup] execute task=${task.id} kind=${task.kind} count=${task.count} concurrency=${task.concurrency}`,
  );
  await persistSignupTask(task, deps);

  const ensureNotStopped = () => {
    const currentTask = state.tasks.get(taskId);
    const currentControl = state.control.get(taskId);
    if (!currentTask || !currentControl) {
      const error = new Error("Task deleted") as Error & { code?: string };
      error.code = "task_deleted";
      throw error;
    }
    if (currentControl.stopRequested) {
      const error = new Error("Task stopped") as Error & { code?: string };
      error.code = "task_stopped";
      throw error;
    }
  };

  try {
    if (task.kind === "team-member") {
      const execution: TeamMemberSignupExecutionResult =
        await deps.runTeamMemberSignupBatch({
          count: task.count,
          concurrency: task.concurrency,
          domains: control.cloudMailDomains ?? [],
          ensureNotStopped,
          onAccountSaved: async (savedCount: number) => {
            const currentTask = state.tasks.get(taskId);
            if (!currentTask || currentTask.kind !== "team-member") return;
            currentTask.savedCount = savedCount;
            await persistSignupTask(currentTask, deps);
          },
        });

      ensureNotStopped();
      task.savedCount = execution.createdCount;
      task.result = {
        kind: "team-member",
        ...(summarizeSignupResult(execution.flowResult) ?? {}),
        successCount: execution.createdCount,
        failedCount: execution.failedCount,
        saveFailures: execution.saveFailures,
      } as unknown as SignupFlowResult | SignupBatchResult;
      task.status =
        execution.createdCount === 0 && execution.saveFailures.length > 0
          ? "failed"
          : "completed";
      task.finishedAt = new Date().toISOString();
      task.durationMs = Date.now() - startedAt;
      task.error =
        task.status === "failed"
          ? (execution.saveFailures[0] ?? "No team member accounts were saved")
          : null;
      if (execution.saveFailures.length > 0) {
        console.warn(
          `[signup] task ${task.id} completed with ${execution.saveFailures.length} team-member save failures`,
        );
        for (const failure of execution.saveFailures) {
          console.error(`[signup] task ${task.id} team-member save failure: ${failure}`);
        }
      }
      await persistTerminalSignupTask(task, deps);
      pruneSignupTasksInMemory();
      return;
    }

    if (task.kind === "team-member-fill") {
      const ownerEmail = control.ownerEmail?.trim().toLowerCase() ?? "";
      if (!ownerEmail) {
        throw new Error("ownerEmail is required for team-member-fill task");
      }
      console.info(
        `[signup] team-member-fill start task=${task.id} owner=${ownerEmail} count=${task.count}`,
      );
      const execution: TeamMemberSignupExecutionResult =
        await deps.runTeamMemberSignupBatch({
          count: task.count,
          concurrency: task.concurrency,
          domains: control.cloudMailDomains ?? [],
          ownerEmail,
          portalUserId: control.portalUserId,
          ensureNotStopped,
          onAccountSaved: async (savedCount: number) => {
            const currentTask = state.tasks.get(taskId);
            if (!currentTask || currentTask.kind !== "team-member-fill") return;
            currentTask.savedCount = savedCount;
            await persistSignupTask(currentTask, deps);
          },
        });

      ensureNotStopped();
      console.info(
        `[signup] team-member-fill signup-finished task=${task.id} owner=${ownerEmail} invited=${execution.invitedCount} created=${execution.createdCount} failed=${execution.failedCount}`,
      );
      console.info(
        `[signup] team-member-fill join-skipped task=${task.id} owner=${ownerEmail} joined=${execution.createdCount} failed=0`,
      );
      task.savedCount = execution.createdCount;
      task.result = {
        kind: "team-member-fill",
        ownerEmail,
        invitedCount: execution.invitedCount,
        createdCount: execution.createdCount,
        joinedCount: execution.createdCount,
        failedCount: execution.failedCount,
        saveFailures: execution.saveFailures,
        total: task.count,
      } as unknown as SignupBatchResult & Record<string, unknown>;
      task.status =
        execution.createdCount === 0 && execution.saveFailures.length > 0
          ? "failed"
          : "completed";
      task.finishedAt = new Date().toISOString();
      task.durationMs = Date.now() - startedAt;
      const firstFailure = execution.saveFailures[0] ?? null;
      task.error =
        task.status === "failed"
          ? (firstFailure ?? "No team members were created and joined successfully")
          : firstFailure;
      if (execution.saveFailures.length > 0) {
        console.warn(
          `[signup] task ${task.id} completed with ${execution.saveFailures.length} team-member-fill save failures`,
        );
        for (const failure of execution.saveFailures) {
          console.error(`[signup] task ${task.id} team-member-fill save failure: ${failure}`);
        }
      }
      await persistTerminalSignupTask(task, deps);
      pruneSignupTasksInMemory();
      return;
    }

    if (task.kind === "team-member-join") {
      const memberEmails = Array.from(
        new Set(
          (control.memberEmails ?? [])
            .map((item) => item.trim().toLowerCase())
            .filter((item) => item.length > 0),
        ),
      );
      const processedEmails = new Set<string>();
      const execution = await deps.joinMembersToAvailableTeams({
        memberEmails,
        ensureNotStopped,
        onMemberProcessed: async (result: { ok: boolean; email: string }) => {
          if (result.ok && !processedEmails.has(result.email)) {
            processedEmails.add(result.email);
            const currentTask = state.tasks.get(taskId);
            if (!currentTask || currentTask.kind !== "team-member-join") return;
            currentTask.savedCount = processedEmails.size;
            await persistSignupTask(currentTask, deps);
          }
        },
      });

      ensureNotStopped();
      task.savedCount = execution.successCount;
      task.result = {
        kind: "team-member-join",
        total: execution.results.length,
        successCount: execution.successCount,
        failedCount: execution.failedCount,
      } as unknown as SignupBatchResult & Record<string, unknown>;
      task.status =
        execution.successCount === 0 && execution.failedCount > 0
          ? "failed"
          : "completed";
      task.finishedAt = new Date().toISOString();
      task.durationMs = Date.now() - startedAt;
      task.error =
        task.status === "failed"
          ? (execution.results.find((item: { ok: boolean; error?: string }) => !item.ok)
              ?.error ?? "No team members were joined successfully")
          : null;
      await persistTerminalSignupTask(task, deps);
      pruneSignupTasksInMemory();
      return;
    }

    if (task.kind === "team-owner") {
      const execution: TeamOwnerSignupExecutionResult =
        await deps.runTeamOwnerSignupBatch({
          count: task.count,
          concurrency: task.concurrency,
          domains: control.ownerMailDomains ?? [],
          ensureNotStopped,
          onAccountSaved: async (savedCount: number) => {
            const currentTask = state.tasks.get(taskId);
            if (!currentTask || currentTask.kind !== "team-owner") return;
            currentTask.savedCount = savedCount;
            await persistSignupTask(currentTask, deps);
          },
        });

      ensureNotStopped();
      task.savedCount = execution.createdCount;
      task.result = {
        kind: "team-owner",
        ...(summarizeSignupResult(execution.flowResult) ?? {}),
        successCount: execution.createdCount,
        failedCount: execution.failedCount,
        saveFailures: execution.saveFailures,
      } as unknown as SignupFlowResult | SignupBatchResult;
      task.status =
        execution.createdCount === 0 && execution.saveFailures.length > 0
          ? "failed"
          : "completed";
      task.finishedAt = new Date().toISOString();
      task.durationMs = Date.now() - startedAt;
      task.error =
        task.status === "failed"
          ? (execution.saveFailures[0] ?? "No team owner accounts were saved")
          : null;
      if (execution.saveFailures.length > 0) {
        console.warn(
          `[signup] task ${task.id} completed with ${execution.saveFailures.length} team-owner save failures`,
        );
        for (const failure of execution.saveFailures) {
          console.error(`[signup] task ${task.id} team-owner save failure: ${failure}`);
        }
      }
      await persistTerminalSignupTask(task, deps);
      pruneSignupTasksInMemory();
      return;
    }

    if (
      typeof signupModule.runSignupFlow !== "function" ||
      typeof signupModule.runSignupBatch !== "function"
    ) {
      throw new Error(
        "runSignupFlow or runSignupBatch is not exported from @workspace/openai-signup",
      );
    }

    await deps.ensureDatabaseSchema();
    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    const persistAccount = async (account: SignupFlowAccount) => {
      ensureNotStopped();
      const rateLimit = await deps.resolveRateLimitForAccount(account, runtimeConfig);
      const saved = await deps.upsertOpenAIAccount({
        email: account.email,
        userId: account.userId,
        name: account.name,
        picture: account.picture,
        accountId: account.accountId,
        accountUserRole: account.accountUserRole,
        workspaceName: account.workspaceName,
        planType: account.planType,
        workspaceIsDeactivated: account.workspaceIsDeactivated,
        workspaceCancelledAt: account.workspaceCancelledAt,
        status: account.status,
        isShared: account.isShared,
        accessToken: account.accessToken,
        refreshToken: null,
        sessionToken: account.sessionToken,
        type: account.type,
        rateLimit,
      });
      await deps.markAccountCoolingDown({
        account: saved,
        fallbackRateLimit: rateLimit,
      });
      const currentTask = state.tasks.get(taskId);
      if (!currentTask) return;
      currentTask.savedCount += 1;
      await persistSignupTask(currentTask, deps);
    };

    ensureNotStopped();
    const flowResult = await signupModule.runSignupBatch({
      count: task.count,
      concurrency: Math.max(1, Math.min(task.concurrency, task.count)),
      proxyPool: control.proxyPool,
      includeResults: false,
      onResult: async (result) => {
        ensureNotStopped();
        if (result?.ok && result.account) {
          await persistAccount(result.account);
        }
      },
    });

    ensureNotStopped();
    task.result = summarizeSignupResult(flowResult) as
      | SignupFlowResult
      | SignupBatchResult;
    task.status = "completed";
    task.finishedAt = new Date().toISOString();
    task.durationMs = Date.now() - startedAt;
    await persistTerminalSignupTask(task, deps);
    pruneSignupTasksInMemory();
  } catch (error) {
    const errObj = error as Error & { code?: string };
    if (errObj.code === "task_stopped") {
      task.status = "stopped";
      task.error = null;
      task.finishedAt = new Date().toISOString();
      task.durationMs = Date.now() - startedAt;
      await persistTerminalSignupTask(task, deps);
      pruneSignupTasksInMemory();
      return;
    }
    if (errObj.code === "task_deleted") return;
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[signup] task ${task.id} execute failed: ${err.message}`);
    task.status = "failed";
    task.error = err.message;
    task.finishedAt = new Date().toISOString();
    task.durationMs = Date.now() - startedAt;
    await persistTerminalSignupTask(task, deps);
    pruneSignupTasksInMemory();
  } finally {
    const currentControl = state.control.get(taskId);
    if (currentControl) {
      currentControl.stopRequested = false;
    }
  }
}

export function scheduleSignupTasks(deps: any) {
  while (
    state.scheduler.runningWorkers < state.scheduler.maxWorkers &&
    state.queue.length > 0
  ) {
    const nextTaskId = state.queue.shift();
    if (!nextTaskId) break;
    const task = state.tasks.get(nextTaskId);
    if (!task || task.status !== "pending") continue;
    state.scheduler.runningWorkers += 1;
    void executeSignupTask(nextTaskId, deps)
      .catch((error) => {
        console.warn(
          `[signup] task ${nextTaskId} failed to execute: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        state.scheduler.runningWorkers = Math.max(
          0,
          state.scheduler.runningWorkers - 1,
        );
        scheduleSignupTasks(deps);
      });
  }
}

export function getSignupTaskState() {
  return state;
}
