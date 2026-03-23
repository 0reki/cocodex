import type { Express, Request, Response } from "express";

import {
  createPendingTask,
  createSchedulerView,
  getSignupMaxCount,
  getSignupTaskState,
  isOpenAISignupTaskKind,
  isSignupTaskTerminal,
  persistSignupTask,
  removeSignupTaskFromQueue,
  resolveSignupTaskKindFromResult,
  scheduleSignupTasks,
  toTaskView,
} from "./core.ts";
import {
  type SignupBatchResult,
  type SignupFlowResult,
  type SignupTaskControlStatus,
  type SignupTaskKind,
  summarizeSignupResult,
} from "./types.ts";

export function registerSignupTaskRoutes(app: Express, deps: any) {
  const state = getSignupTaskState();
  const getRequesterUserId = (res: Response) =>
    typeof res.locals.portalSession?.sub === "string"
      ? res.locals.portalSession.sub.trim()
      : "";

  app.post("/api/openai-signup/tasks", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawCount =
        typeof body.count === "number" ? body.count : Number(body.count ?? 1);
      const count = Math.max(
        1,
        Math.floor(Number.isFinite(rawCount) ? rawCount : 1),
      );
      const rawConcurrency =
        typeof body.concurrency === "number"
          ? body.concurrency
          : Number(body.concurrency ?? 4);
      const concurrency = Math.max(
        1,
        Math.min(
          count,
          Math.floor(Number.isFinite(rawConcurrency) ? rawConcurrency : 1),
        ),
      );

      await deps.ensureDatabaseSchema();
      const proxyRows = await deps.listSignupProxies(true);
      const proxyPool = proxyRows.map((item: { proxyUrl: string }) => item.proxyUrl);
      deps.shuffleInPlace(proxyPool);

      const autoStart = body.autoStart !== false;
      const task = createPendingTask("openai", count, concurrency, proxyPool.length);
      state.tasks.set(task.id, task);
      state.control.set(task.id, {
        proxyPool,
        requesterUserId: getRequesterUserId(res),
        stopRequested: false,
      });
      if (autoStart) {
        state.queue.push(task.id);
        scheduleSignupTasks(deps);
      }
      await persistSignupTask(task, deps);

      res.status(202).json({
        ok: true,
        queued: autoStart,
        scheduler: createSchedulerView(),
        task: toTaskView(task),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/openai-signup/tasks", async (req: Request, res: Response) => {
    try {
      const rawLimit =
        typeof req.query.limit === "string"
          ? Number(req.query.limit)
          : Number(Array.isArray(req.query.limit) ? req.query.limit[0] : 50);
      const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50;
      await deps.ensureDatabaseSchema();
      const rows = await deps.listSignupTasks(limit);
      const mapped = rows
        .map((row: any) => {
          const result = row.result as SignupFlowResult | SignupBatchResult | null;
          const kind = resolveSignupTaskKindFromResult(result);
          return {
            id: row.id,
            kind,
            status: row.status as SignupTaskControlStatus,
            count: row.count,
            concurrency: row.concurrency,
            cpuMaxConcurrency: row.cpuMaxConcurrency,
            proxyPoolSize: row.proxyPoolSize,
            savedCount: row.savedCount,
            createdAt: row.createdAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            durationMs: row.durationMs,
            error: row.error,
            result: summarizeSignupResult(result),
          };
        })
        .filter((task: { kind: SignupTaskKind }) => isOpenAISignupTaskKind(task.kind));
      res.json({ ok: true, tasks: mapped });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/openai-signup/tasks/:taskId", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (task && isOpenAISignupTaskKind(task.kind)) {
      res.json({ ok: true, task: toTaskView(task) });
      return;
    }

    try {
      await deps.ensureDatabaseSchema();
      const persisted = await deps.getSignupTaskById(taskId);
      if (!persisted) {
        res.status(404).json({ ok: false, error: "Task not found" });
        return;
      }
      const kind = resolveSignupTaskKindFromResult(persisted.result);
      if (!isOpenAISignupTaskKind(kind)) {
        res.status(404).json({ ok: false, error: "Task not found" });
        return;
      }
      res.json({
        ok: true,
        task: {
          id: persisted.id,
          kind,
          status: persisted.status as SignupTaskControlStatus,
          count: persisted.count,
          concurrency: persisted.concurrency,
          cpuMaxConcurrency: persisted.cpuMaxConcurrency,
          proxyPoolSize: persisted.proxyPoolSize,
          savedCount: persisted.savedCount,
          createdAt: persisted.createdAt,
          startedAt: persisted.startedAt,
          finishedAt: persisted.finishedAt,
          durationMs: persisted.durationMs,
          error: persisted.error,
          result: summarizeSignupResult(
            persisted.result as SignupFlowResult | SignupBatchResult | null,
          ),
        },
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-signup/tasks/:taskId/start", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (!task || !isOpenAISignupTaskKind(task.kind)) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    if (task.status === "running" || task.status === "stopping") {
      res.status(409).json({ ok: false, error: "Task is already running" });
      return;
    }
    if (task.status === "completed") {
      res.status(409).json({ ok: false, error: "Completed task cannot be started again" });
      return;
    }

    const control = state.control.get(taskId);
    if (!control) {
      res.status(409).json({
        ok: false,
        error: "Task cannot be started after server restart; create a new task",
      });
      return;
    }
    control.stopRequested = false;
    task.status = "pending";
    task.startedAt = null;
    task.finishedAt = null;
    task.durationMs = null;
    task.error = null;
    task.result = task.kind === "openai" ? null : { kind: task.kind };
    task.savedCount = 0;
    removeSignupTaskFromQueue(taskId);
    state.queue.push(taskId);
    await persistSignupTask(task, deps);
    scheduleSignupTasks(deps);

    res.json({
      ok: true,
      scheduler: createSchedulerView(),
      task: toTaskView(task),
    });
  });

  app.post("/api/openai-signup/tasks/:taskId/stop", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (!task || !isOpenAISignupTaskKind(task.kind)) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    if (isSignupTaskTerminal(task.status)) {
      res.status(409).json({ ok: false, error: "Task already finished" });
      return;
    }
    if (task.status === "pending") {
      removeSignupTaskFromQueue(taskId);
      task.status = "stopped";
      task.finishedAt = new Date().toISOString();
      const createdAtMs = Date.parse(task.createdAt);
      task.durationMs = Number.isNaN(createdAtMs)
        ? null
        : Math.max(0, Date.now() - createdAtMs);
      task.error = null;
      await persistSignupTask(task, deps);
      res.json({ ok: true, task: toTaskView(task) });
      return;
    }

    const control = state.control.get(taskId);
    if (!control) {
      res.status(409).json({ ok: false, error: "Task is not stoppable now" });
      return;
    }
    control.stopRequested = true;
    task.status = "stopping";
    await persistSignupTask(task, deps);
    res.json({ ok: true, task: toTaskView(task) });
  });

  app.delete("/api/openai-signup/tasks/:taskId", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (
      task &&
      isOpenAISignupTaskKind(task.kind) &&
      (task.status === "running" || task.status === "stopping")
    ) {
      const control = state.control.get(taskId);
      if (control) control.stopRequested = true;
    }

    removeSignupTaskFromQueue(taskId);
    state.control.delete(taskId);
    state.tasks.delete(taskId);

    try {
      await deps.ensureDatabaseSchema();
      await deps.deleteSignupTaskById(taskId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/team-accounts/owner/create", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawCount =
        typeof body.count === "number" ? body.count : Number(body.count ?? 1);
      const safeCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : 1;
      const count = Math.max(1, Math.min(getSignupMaxCount(), safeCount));
      const rawConcurrency =
        typeof body.concurrency === "number"
          ? body.concurrency
          : Number(body.concurrency ?? 1);
      const safeConcurrency = Number.isFinite(rawConcurrency)
        ? Math.floor(rawConcurrency)
        : 1;
      const concurrency = Math.max(1, Math.min(count, safeConcurrency));

      await deps.ensureDatabaseSchema();
      const settings = await deps.getSystemSettings();
      const domains = (settings?.ownerMailDomains ?? []).filter(
        (item: unknown): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
      if (domains.length === 0) {
        res.status(400).json({
          ok: false,
          error: "No owner mail domains configured in system settings",
        });
        return;
      }

      const autoStart = body.autoStart !== false;
      const task = createPendingTask("team-owner", count, concurrency, 0);
      state.tasks.set(task.id, task);
      state.control.set(task.id, {
        proxyPool: [],
        requesterUserId: getRequesterUserId(res),
        stopRequested: false,
        ownerMailDomains: domains,
      });
      if (autoStart) {
        state.queue.push(task.id);
        scheduleSignupTasks(deps);
      }
      await persistSignupTask(task, deps);

      res.status(202).json({
        ok: true,
        queued: autoStart,
        scheduler: createSchedulerView(),
        task: toTaskView(task),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({
        ok: false,
        error: err.message,
        stack: err.stack,
      });
    }
  });

  app.post("/api/team-accounts/member/create", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawCount =
        typeof body.count === "number" ? body.count : Number(body.count ?? 1);
      const safeCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : 1;
      const count = Math.max(1, Math.min(getSignupMaxCount(), safeCount));
      const rawConcurrency =
        typeof body.concurrency === "number"
          ? body.concurrency
          : Number(body.concurrency ?? 1);
      const safeConcurrency = Number.isFinite(rawConcurrency)
        ? Math.floor(rawConcurrency)
        : 1;
      const concurrency = Math.max(1, Math.min(count, safeConcurrency));

      await deps.ensureDatabaseSchema();
      const settings = await deps.getSystemSettings();
      const domains = (settings?.cloudMailDomains ?? []).filter(
        (item: unknown): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
      if (domains.length === 0) {
        res.status(400).json({
          ok: false,
          error: "No cloud-mail domains configured in system settings",
        });
        return;
      }

      const autoStart = body.autoStart !== false;
      const task = createPendingTask("team-member", count, concurrency, 0);
      state.tasks.set(task.id, task);
      state.control.set(task.id, {
        proxyPool: [],
        requesterUserId: getRequesterUserId(res),
        stopRequested: false,
        cloudMailDomains: domains,
      });
      if (autoStart) {
        state.queue.push(task.id);
        scheduleSignupTasks(deps);
      }
      await persistSignupTask(task, deps);

      res.status(202).json({
        ok: true,
        queued: autoStart,
        scheduler: createSchedulerView(),
        task: toTaskView(task),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({
        ok: false,
        error: err.message,
        stack: err.stack,
      });
    }
  });

  app.post("/api/team-accounts/owner/fill-members", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ownerEmail =
        typeof body.ownerEmail === "string" ? body.ownerEmail.trim().toLowerCase() : "";
      const portalUserId = getRequesterUserId(res);
      if (!ownerEmail) {
        res.status(400).json({ ok: false, error: "ownerEmail is required" });
        return;
      }
      if (!portalUserId) {
        res.status(400).json({ ok: false, error: "portalUserId is required" });
        return;
      }
      const rawCount =
        typeof body.count === "number" ? body.count : Number(body.count ?? 1);
      const safeCount = Number.isFinite(rawCount) ? Math.floor(rawCount) : 1;
      const count = Math.max(1, Math.min(getSignupMaxCount(), safeCount));
      const rawConcurrency =
        typeof body.concurrency === "number"
          ? body.concurrency
          : Number(body.concurrency ?? 1);
      const safeConcurrency = Number.isFinite(rawConcurrency)
        ? Math.floor(rawConcurrency)
        : 1;
      const concurrency = Math.max(1, Math.min(count, safeConcurrency));

      await deps.ensureDatabaseSchema();
      if ((res.locals.portalSession?.role ?? "").trim().toLowerCase() !== "admin") {
        const owner = await deps.getTeamOwnerAccountByEmail(ownerEmail);
        const ownerPortalUserId = owner?.portalUserId?.trim() ?? "";
        const ownerId = owner?.ownerId?.trim() ?? "";
        if (!owner || (ownerPortalUserId !== portalUserId && ownerId !== portalUserId)) {
          res.status(403).json({ ok: false, error: "Forbidden" });
          return;
        }
      }
      const settings = await deps.getSystemSettings();
      const domains = (settings?.cloudMailDomains ?? []).filter(
        (item: unknown): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
      if (domains.length === 0) {
        res.status(400).json({
          ok: false,
          error: "No cloud-mail domains configured in system settings",
        });
        return;
      }

      const autoStart = body.autoStart !== false;
      const task = createPendingTask("team-member-fill", count, concurrency, 0);
      state.tasks.set(task.id, task);
      state.control.set(task.id, {
        proxyPool: [],
        requesterUserId: getRequesterUserId(res),
        stopRequested: false,
        cloudMailDomains: domains,
        ownerEmail,
        portalUserId,
      });
      if (autoStart) {
        state.queue.push(task.id);
        scheduleSignupTasks(deps);
      }
      await persistSignupTask(task, deps);

      res.status(202).json({
        ok: true,
        queued: autoStart,
        scheduler: createSchedulerView(),
        task: toTaskView(task),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({
        ok: false,
        error: err.message,
        stack: err.stack,
      });
    }
  });

  app.post("/api/team-accounts/member/join-team", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const memberEmails = Array.isArray(body.memberEmails)
        ? body.memberEmails.filter((item): item is string => typeof item === "string")
        : [];
      const normalizedMemberEmails = Array.from(
        new Set(
          memberEmails
            .map((item) => item.trim().toLowerCase())
            .filter((item) => item.length > 0),
        ),
      );
      if (normalizedMemberEmails.length === 0) {
        res.status(400).json({ ok: false, error: "memberEmails is required" });
        return;
      }

      const autoStart = body.autoStart !== false;
      const task = createPendingTask(
        "team-member-join",
        normalizedMemberEmails.length,
        1,
        0,
      );
      state.tasks.set(task.id, task);
      state.control.set(task.id, {
        proxyPool: [],
        requesterUserId: getRequesterUserId(res),
        stopRequested: false,
        memberEmails: normalizedMemberEmails,
      });
      if (autoStart) {
        state.queue.push(task.id);
        scheduleSignupTasks(deps);
      }
      await persistSignupTask(task, deps);

      res.status(202).json({
        ok: true,
        queued: autoStart,
        scheduler: createSchedulerView(),
        task: toTaskView(task),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/team-accounts/member/tasks", async (req: Request, res: Response) => {
    try {
      const rawLimit =
        typeof req.query.limit === "string"
          ? Number(req.query.limit)
          : Number(Array.isArray(req.query.limit) ? req.query.limit[0] : 50);
      const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50;
      await deps.ensureDatabaseSchema();
      const rows = await deps.listSignupTasks(limit);
      const mapped = rows
        .map((row: any) => {
          const result = row.result as SignupFlowResult | SignupBatchResult | null;
          const kind = resolveSignupTaskKindFromResult(result);
          return {
            id: row.id,
            kind,
            status: row.status as SignupTaskControlStatus,
            count: row.count,
            concurrency: row.concurrency,
            cpuMaxConcurrency: row.cpuMaxConcurrency,
            proxyPoolSize: row.proxyPoolSize,
            savedCount: row.savedCount,
            createdAt: row.createdAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            durationMs: row.durationMs,
            error: row.error,
            result: summarizeSignupResult(result),
          };
        })
        .filter(
          (task: { kind: SignupTaskKind }) =>
            task.kind === "team-member" || task.kind === "team-member-join",
        );
      res.json({ ok: true, tasks: mapped });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/team-accounts/member/tasks/:taskId", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (task && (task.kind === "team-member" || task.kind === "team-member-join")) {
      res.json({ ok: true, task: toTaskView(task) });
      return;
    }

    try {
      await deps.ensureDatabaseSchema();
      const persisted = await deps.getSignupTaskById(taskId);
      if (!persisted) {
        res.status(404).json({ ok: false, error: "Task not found" });
        return;
      }
      const kind = resolveSignupTaskKindFromResult(persisted.result);
      if (kind !== "team-member" && kind !== "team-member-join") {
        res.status(404).json({ ok: false, error: "Task not found" });
        return;
      }
      res.json({
        ok: true,
        task: {
          id: persisted.id,
          kind,
          status: persisted.status as SignupTaskControlStatus,
          count: persisted.count,
          concurrency: persisted.concurrency,
          cpuMaxConcurrency: persisted.cpuMaxConcurrency,
          proxyPoolSize: persisted.proxyPoolSize,
          savedCount: persisted.savedCount,
          createdAt: persisted.createdAt,
          startedAt: persisted.startedAt,
          finishedAt: persisted.finishedAt,
          durationMs: persisted.durationMs,
          error: persisted.error,
          result: summarizeSignupResult(
            persisted.result as SignupFlowResult | SignupBatchResult | null,
          ),
        },
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/team-accounts/member/tasks/:taskId/start", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (!task || (task.kind !== "team-member" && task.kind !== "team-member-join")) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    if (task.status === "running" || task.status === "stopping") {
      res.status(409).json({ ok: false, error: "Task is already running" });
      return;
    }
    if (task.status === "completed") {
      res.status(409).json({ ok: false, error: "Completed task cannot be started again" });
      return;
    }
    const control = state.control.get(taskId);
    if (!control) {
      res.status(409).json({
        ok: false,
        error: "Task cannot be started after server restart; create a new task",
      });
      return;
    }
    control.stopRequested = false;
    task.status = "pending";
    task.startedAt = null;
    task.finishedAt = null;
    task.durationMs = null;
    task.error = null;
    task.result = { kind: task.kind };
    task.savedCount = 0;
    removeSignupTaskFromQueue(taskId);
    state.queue.push(taskId);
    await persistSignupTask(task, deps);
    scheduleSignupTasks(deps);

    res.json({
      ok: true,
      scheduler: createSchedulerView(),
      task: toTaskView(task),
    });
  });

  app.post("/api/team-accounts/member/tasks/:taskId/stop", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (!task || (task.kind !== "team-member" && task.kind !== "team-member-join")) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    if (isSignupTaskTerminal(task.status)) {
      res.status(409).json({ ok: false, error: "Task already finished" });
      return;
    }
    if (task.status === "pending") {
      removeSignupTaskFromQueue(taskId);
      task.status = "stopped";
      task.finishedAt = new Date().toISOString();
      const createdAtMs = Date.parse(task.createdAt);
      task.durationMs = Number.isNaN(createdAtMs)
        ? null
        : Math.max(0, Date.now() - createdAtMs);
      task.error = null;
      await persistSignupTask(task, deps);
      res.json({ ok: true, task: toTaskView(task) });
      return;
    }
    const control = state.control.get(taskId);
    if (!control) {
      res.status(409).json({ ok: false, error: "Task is not stoppable now" });
      return;
    }
    control.stopRequested = true;
    task.status = "stopping";
    await persistSignupTask(task, deps);
    res.json({ ok: true, task: toTaskView(task) });
  });

  app.delete("/api/team-accounts/member/tasks/:taskId", async (req: Request, res: Response) => {
    const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
    if (!taskId) {
      res.status(400).json({ ok: false, error: "taskId is required" });
      return;
    }
    const task = state.tasks.get(taskId);
    if (
      task &&
      (task.kind === "team-member" || task.kind === "team-member-join") &&
      (task.status === "running" || task.status === "stopping")
    ) {
      const control = state.control.get(taskId);
      if (control) control.stopRequested = true;
    }

    removeSignupTaskFromQueue(taskId);
    state.control.delete(taskId);
    state.tasks.delete(taskId);

    try {
      await deps.ensureDatabaseSchema();
      await deps.deleteSignupTaskById(taskId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
