import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { getCodexModels } from "@workspace/openai-api";

export function registerAdminRoutes(app: Express, deps: any) {
  const {
    listOpenAIAccountsPage,
    ensureApiKeysCacheLoaded,
    getPortalSessionFromLocals,
    apiKeysCache,
    generateApiKeyValue,
    setApiKeysCache,
    createApiKey,
    deleteApiKeyById,
    updateApiKeyById,
    getOpenAIAccountByEmail,
    deleteOpenAIAccountByEmail,
    deleteOpenAIAccountsByEmails,
    disableOpenAIAccountByEmail,
    enableOpenAIAccountByEmail,
    disableOpenAIAccountsByEmails,
    ensureDatabaseSchema,
    listSignupProxies,
    replaceSignupProxies,
    invalidateSignupProxyPoolCache,
    getOpenAIApiRuntimeConfig,
    resolveRateLimitForAccount,
    upsertOpenAIAccount,
    markAccountCoolingDown,
    ensureOpenAIModelsCacheLoaded,
    ensureOpenAIAccountsLruLoaded,
    getSystemSettings,
    applyOpenAIAccountCacheOptionsFromSettings,
    openAIModelsCache,
    openAIAccountsLruCache,
    upstreamRetryConfig,
    requestRateLimitConfig,
    DEFAULT_CHECK_IN_REWARD_MIN,
    DEFAULT_CHECK_IN_REWARD_MAX,
    normalizeCloudMailDomains,
    normalizeOwnerMailDomains,
    normalizeAccountCacheSize,
    normalizeAccountCacheRefreshSeconds,
    normalizeMaxAttemptCount,
    normalizeUserRpmLimit,
    normalizeUserMaxInFlight,
    normalizeCheckInReward,
    sanitizeOpenAIModelsForStorage,
    upsertSystemSettings,
    updateSystemSettingsOpenAIModels,
    setOpenAIModelsCache,
    invalidateOpenAIApiRuntimeConfigCache,
    getRandomOpenAIModelRefreshAccount,
    getRandomTeamOwnerModelRefreshAccount,
    mergeModelPricesBySlug,
    MODELS_REFRESH_CLIENT_VERSION,
    isOpenAIModelEnabled,
  } = deps;

  app.get("/api/openai-accounts", async (req: Request, res: Response) => {
    try {
      const pageRaw = Number(req.query.page ?? 1);
      const pageSizeRaw = Number(req.query.pageSize ?? req.query.limit ?? 50);
      const statusRaw =
        typeof req.query.status === "string" ? req.query.status : "";
      const keywordRaw = typeof req.query.q === "string" ? req.query.q : "";
      const page = Number.isFinite(pageRaw)
        ? Math.max(1, Math.floor(pageRaw))
        : 1;
      const pageSize = Number.isFinite(pageSizeRaw)
        ? Math.max(1, Math.min(500, Math.floor(pageSizeRaw)))
        : 50;
      const data = await listOpenAIAccountsPage(page, pageSize, {
        status: statusRaw,
        keyword: keywordRaw,
      });
      res.json({
        items: data.items,
        count: data.total,
        page: data.page,
        pageSize: data.pageSize,
        totalPages: Math.max(1, Math.ceil(data.total / data.pageSize)),
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list accounts",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/api-keys", async (_req: Request, res: Response) => {
    try {
      await ensureApiKeysCacheLoaded();
      const session = getPortalSessionFromLocals(res);
      if (!session) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const requesterUserId = session.sub;
      const visibleItems = apiKeysCache.items.filter(
        (item: { ownerUserId: string | null }) =>
          item.ownerUserId === requesterUserId,
      );
      res.json({ items: visibleItems, count: visibleItems.length });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list API keys",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/api-keys", async (req: Request, res: Response) => {
    try {
      await ensureApiKeysCacheLoaded();
      const session = getPortalSessionFromLocals(res);
      if (!session) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const requesterUserId = session.sub;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ ok: false, error: "name is required" });
        return;
      }
      const quotaInput = body.quota;
      let quota: number | null = null;
      if (!(quotaInput === null || quotaInput === undefined || quotaInput === "")) {
        const quotaRaw =
          typeof quotaInput === "number"
            ? quotaInput
            : typeof quotaInput === "string"
              ? Number(quotaInput)
              : NaN;
        if (!(Number.isFinite(quotaRaw) && quotaRaw >= 0)) {
          res.status(400).json({ ok: false, error: "quota is invalid" });
          return;
        }
        quota = quotaRaw;
      }

      let expiresAt: string | null = null;
      if (!(body.expiresAt === null || body.expiresAt === undefined)) {
        const expiresAtRaw =
          typeof body.expiresAt === "string" ? body.expiresAt.trim() : "";
        if (expiresAtRaw) {
          if (Number.isNaN(Date.parse(expiresAtRaw))) {
            res.status(400).json({ ok: false, error: "expiresAt is invalid" });
            return;
          }
          expiresAt = expiresAtRaw;
        }
      }
      const ownerUserId = requesterUserId;
      const optimisticItem = {
        id: crypto.randomUUID(),
        ownerUserId,
        name,
        apiKey: generateApiKeyValue(),
        quota,
        used: 0,
        expiresAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setApiKeysCache([optimisticItem, ...apiKeysCache.items]);

      const item = await createApiKey({
        ownerUserId,
        name: optimisticItem.name,
        apiKey: optimisticItem.apiKey,
        quota,
        expiresAt,
      });
      setApiKeysCache([
        item,
        ...apiKeysCache.items.filter(
          (cacheItem: { id: string }) => cacheItem.id !== optimisticItem.id,
        ),
      ]);
      res.status(201).json({ ok: true, item });
    } catch (error) {
      await ensureApiKeysCacheLoaded(true);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete("/api/api-keys/:id", async (req: Request, res: Response) => {
    try {
      await ensureApiKeysCacheLoaded();
      const session = getPortalSessionFromLocals(res);
      if (!session) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const requesterUserId = session.sub;
      const idParam = req.params.id;
      if (typeof idParam !== "string" || !idParam.trim()) {
        res.status(400).json({ ok: false, error: "id param is required" });
        return;
      }
      const idx = apiKeysCache.items.findIndex(
        (item: { id: string }) => item.id === idParam,
      );
      if (idx < 0) {
        res.status(404).json({ ok: false, error: "API key not found" });
        return;
      }
      const removed = apiKeysCache.items[idx]!;
      if (removed.ownerUserId !== requesterUserId) {
        res.status(404).json({ ok: false, error: "API key not found" });
        return;
      }
      const next = [...apiKeysCache.items];
      next.splice(idx, 1);
      setApiKeysCache(next);

      const deleted = await deleteApiKeyById(idParam, {
        ownerUserId: requesterUserId,
      });
      if (!deleted) {
        const rollback = [...apiKeysCache.items];
        rollback.splice(idx, 0, removed);
        setApiKeysCache(rollback);
        res.status(404).json({ ok: false, error: "API key not found" });
        return;
      }
      res.json({ ok: true, deleted: 1 });
    } catch (error) {
      await ensureApiKeysCacheLoaded(true);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.put("/api/api-keys/:id", async (req: Request, res: Response) => {
    try {
      await ensureApiKeysCacheLoaded();
      const session = getPortalSessionFromLocals(res);
      if (!session) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const requesterUserId = session.sub;
      const idParam = req.params.id;
      if (typeof idParam !== "string" || !idParam.trim()) {
        res.status(400).json({ ok: false, error: "id param is required" });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ ok: false, error: "name is required" });
        return;
      }

      const quotaInput = body.quota;
      let quota: number | null = null;
      if (!(quotaInput === null || quotaInput === undefined || quotaInput === "")) {
        const quotaRaw =
          typeof quotaInput === "number"
            ? quotaInput
            : typeof quotaInput === "string"
              ? Number(quotaInput)
              : NaN;
        if (!(Number.isFinite(quotaRaw) && quotaRaw >= 0)) {
          res.status(400).json({ ok: false, error: "quota is invalid" });
          return;
        }
        quota = quotaRaw;
      }

      let expiresAt: string | null = null;
      if (!(body.expiresAt === null || body.expiresAt === undefined)) {
        const expiresAtRaw =
          typeof body.expiresAt === "string" ? body.expiresAt.trim() : "";
        if (expiresAtRaw) {
          if (Number.isNaN(Date.parse(expiresAtRaw))) {
            res.status(400).json({ ok: false, error: "expiresAt is invalid" });
            return;
          }
          expiresAt = expiresAtRaw;
        }
      }

      const updated = await updateApiKeyById({
        id: idParam,
        name,
        ownerUserId: requesterUserId,
        quota,
        expiresAt,
      });
      if (!updated) {
        res.status(404).json({ ok: false, error: "API key not found" });
        return;
      }
      setApiKeysCache(
        apiKeysCache.items.map((item: { id: string }) =>
          item.id === updated.id ? updated : item,
        ),
      );
      res.json({ ok: true, item: updated });
    } catch (error) {
      await ensureApiKeysCacheLoaded(true);
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/openai-accounts/:email", async (req: Request, res: Response) => {
    try {
      const emailParam = req.params.email;
      if (typeof emailParam !== "string" || !emailParam.trim()) {
        res.status(400).json({ error: "email param is required" });
        return;
      }
      const email = decodeURIComponent(emailParam);
      const row = await getOpenAIAccountByEmail(email);
      if (!row) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      res.json(row);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch account",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete("/api/openai-accounts/:email", async (req: Request, res: Response) => {
    try {
      const emailParam = req.params.email;
      if (typeof emailParam !== "string" || !emailParam.trim()) {
        res.status(400).json({ ok: false, error: "email param is required" });
        return;
      }
      const email = decodeURIComponent(emailParam);
      const deleted = await deleteOpenAIAccountByEmail(email);
      if (!deleted) {
        res.status(404).json({ ok: false, error: "Account not found" });
        return;
      }
      res.json({ ok: true, deleted: 1 });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-accounts/bulk-remove", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const emails = Array.isArray(body.emails)
        ? body.emails.filter((item): item is string => typeof item === "string")
        : [];
      if (emails.length === 0) {
        res.status(400).json({ ok: false, error: "emails is required" });
        return;
      }
      const deleted = await deleteOpenAIAccountsByEmails(emails);
      res.json({ ok: true, deleted, requested: emails.length });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-accounts/:email/disable", async (req: Request, res: Response) => {
    try {
      const emailParam = req.params.email;
      if (typeof emailParam !== "string" || !emailParam.trim()) {
        res.status(400).json({ ok: false, error: "email param is required" });
        return;
      }
      const email = decodeURIComponent(emailParam);
      const updated = await disableOpenAIAccountByEmail(email);
      if (!updated) {
        res.status(404).json({ ok: false, error: "Account not found" });
        return;
      }
      res.json({ ok: true, updated: 1, status: "disabled" });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-accounts/:email/enable", async (req: Request, res: Response) => {
    try {
      const emailParam = req.params.email;
      if (typeof emailParam !== "string" || !emailParam.trim()) {
        res.status(400).json({ ok: false, error: "email param is required" });
        return;
      }
      const email = decodeURIComponent(emailParam);
      const updated = await enableOpenAIAccountByEmail(email);
      if (!updated) {
        res.status(404).json({ ok: false, error: "Account not found" });
        return;
      }
      res.json({ ok: true, updated: 1, status: "Active" });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-accounts/bulk-disable", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const emails = Array.isArray(body.emails)
        ? body.emails.filter((item): item is string => typeof item === "string")
        : [];
      if (emails.length === 0) {
        res.status(400).json({ ok: false, error: "emails is required" });
        return;
      }
      const updated = await disableOpenAIAccountsByEmails(emails);
      res.json({
        ok: true,
        updated,
        requested: emails.length,
        status: "disabled",
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/signup-proxies", async (_req: Request, res: Response) => {
    try {
      await ensureDatabaseSchema();
      const items = await listSignupProxies(false);
      res.json({ items, count: items.length });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list signup proxies",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.put("/api/signup-proxies", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const proxies = Array.isArray(body.proxies)
        ? body.proxies
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
      await ensureDatabaseSchema();
      const items = await replaceSignupProxies(proxies);
      invalidateSignupProxyPoolCache();
      res.json({ items, count: items.length });
    } catch (error) {
      res.status(500).json({
        error: "Failed to replace signup proxies",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-accounts", async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email) {
        res.status(400).json({ error: "email is required" });
        return;
      }

      const runtimeConfig = await getOpenAIApiRuntimeConfig();
      const userId = typeof body.userId === "string" ? body.userId : null;
      const accountId =
        typeof body.accountId === "string" ? body.accountId : null;
      const accessToken =
        typeof body.accessToken === "string" ? body.accessToken : null;
      const sessionToken =
        typeof body.sessionToken === "string" ? body.sessionToken : null;
      const providedRateLimit =
        typeof body.rateLimit === "object" && body.rateLimit !== null
          ? (body.rateLimit as Record<string, unknown>)
          : null;
      const rateLimit = await resolveRateLimitForAccount(
        {
          email,
          userId,
          accountId,
          proxyId: typeof body.proxyId === "string" ? body.proxyId : null,
          accessToken,
          sessionToken,
          rateLimit: providedRateLimit,
        },
        runtimeConfig,
      );

      const row = await upsertOpenAIAccount({
        email,
        userId,
        name: typeof body.name === "string" ? body.name : null,
        picture: typeof body.picture === "string" ? body.picture : null,
        accountId,
        accountUserRole:
          typeof body.accountUserRole === "string" ? body.accountUserRole : null,
        workspaceName:
          typeof body.workspaceName === "string" ? body.workspaceName : null,
        planType: typeof body.planType === "string" ? body.planType : null,
        workspaceIsDeactivated:
          typeof body.workspaceIsDeactivated === "boolean"
            ? body.workspaceIsDeactivated
            : false,
        workspaceCancelledAt:
          typeof body.workspaceCancelledAt === "string"
            ? body.workspaceCancelledAt
            : null,
        status: typeof body.status === "string" ? body.status : null,
        isShared: typeof body.isShared === "boolean" ? body.isShared : false,
        proxyId: typeof body.proxyId === "string" ? body.proxyId : null,
        accessToken,
        refreshToken:
          typeof body.refreshToken === "string" ? body.refreshToken : null,
        sessionToken,
        type: typeof body.type === "string" ? body.type : null,
        cooldownUntil:
          typeof body.cooldownUntil === "string" ? body.cooldownUntil : null,
        rateLimit,
      });
      await markAccountCoolingDown({
        account: row,
        fallbackRateLimit: rateLimit,
      });

      res.status(201).json(row);
    } catch (error) {
      res.status(500).json({
        error: "Failed to upsert account",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/system-settings", async (_req: Request, res: Response) => {
    try {
      const runtimeConfig = await getOpenAIApiRuntimeConfig();
      await ensureOpenAIModelsCacheLoaded();
      await ensureOpenAIAccountsLruLoaded();
      const row = await getSystemSettings();
      applyOpenAIAccountCacheOptionsFromSettings(row);
      res.json({
        openaiApiUserAgent: row?.openaiApiUserAgent ?? null,
        openaiClientVersion: row?.openaiClientVersion ?? null,
        inboxTranslationModel: row?.inboxTranslationModel ?? null,
        cloudMailDomains: row?.cloudMailDomains ?? [],
        ownerMailDomains: row?.ownerMailDomains ?? [],
        accountSubmissionAddonDailyQuota:
          row?.accountSubmissionAddonDailyQuota ?? null,
        accountSubmissionAddonWeeklyCap:
          row?.accountSubmissionAddonWeeklyCap ?? null,
        accountSubmissionAddonMonthlyCap:
          row?.accountSubmissionAddonMonthlyCap ?? null,
        accountCacheSize: row?.accountCacheSize ?? null,
        accountCacheRefreshSeconds: row?.accountCacheRefreshSeconds ?? null,
        maxAttemptCount: row?.maxAttemptCount ?? null,
        userRpmLimit: row?.userRpmLimit ?? null,
        userMaxInFlight: row?.userMaxInFlight ?? null,
        checkInRewardMin: row?.checkInRewardMin ?? null,
        checkInRewardMax: row?.checkInRewardMax ?? null,
        effectiveMaxAttemptCount: upstreamRetryConfig.maxAttemptCount,
        effectiveUserRpmLimit: requestRateLimitConfig.userRpmLimit,
        effectiveUserMaxInFlight: requestRateLimitConfig.userMaxInFlight,
        effectiveCheckInRewardMin:
          row?.checkInRewardMin ?? DEFAULT_CHECK_IN_REWARD_MIN,
        effectiveCheckInRewardMax:
          row?.checkInRewardMax ?? DEFAULT_CHECK_IN_REWARD_MAX,
        effectiveAccountCacheSize: openAIAccountsLruCache.maxSize,
        effectiveAccountCacheRefreshSeconds:
          openAIAccountsLruCache.refreshSeconds,
        openaiModels: openAIModelsCache.models,
        openaiModelsUpdatedAt: openAIModelsCache.updatedAt,
        effectiveOpenAIApiUserAgent: runtimeConfig.userAgent,
        effectiveOpenAIClientVersion: runtimeConfig.clientVersion,
        updatedAt: row?.updatedAt ?? null,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to load system settings",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/public/models", async (_req: Request, res: Response) => {
    try {
      await ensureOpenAIModelsCacheLoaded();
      const row = await getSystemSettings();
      res.json({
        openaiModels: openAIModelsCache.models.filter((model: Record<string, unknown>) =>
          isOpenAIModelEnabled(model),
        ),
        openaiModelsUpdatedAt: openAIModelsCache.updatedAt,
        updatedAt: row?.updatedAt ?? null,
      });
    } catch (error) {
      console.error("[public-models] failed to load", error);
      res.status(500).json({
        error: "Failed to load public models",
      });
    }
  });

  app.put("/api/system-settings", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const existing = await getSystemSettings();
      const hasUserAgent = Object.prototype.hasOwnProperty.call(
        body,
        "openaiApiUserAgent",
      );
      const hasClientVersion = Object.prototype.hasOwnProperty.call(
        body,
        "openaiClientVersion",
      );
      const openaiApiUserAgentRaw =
        hasUserAgent && typeof body.openaiApiUserAgent === "string"
          ? body.openaiApiUserAgent
          : (existing?.openaiApiUserAgent ?? "");
      const openaiClientVersionRaw =
        hasClientVersion && typeof body.openaiClientVersion === "string"
          ? body.openaiClientVersion
          : (existing?.openaiClientVersion ?? "");
      const openaiApiUserAgent = openaiApiUserAgentRaw.trim() || null;
      const openaiClientVersion = openaiClientVersionRaw.trim() || null;
      const hasInboxTranslationModel = Object.prototype.hasOwnProperty.call(
        body,
        "inboxTranslationModel",
      );
      const inboxTranslationModelRaw =
        hasInboxTranslationModel && typeof body.inboxTranslationModel === "string"
          ? body.inboxTranslationModel
          : (existing?.inboxTranslationModel ?? "");
      const inboxTranslationModel = inboxTranslationModelRaw.trim() || null;
      const hasCloudMailDomains = Object.prototype.hasOwnProperty.call(
        body,
        "cloudMailDomains",
      );
      const cloudMailDomainsRaw = hasCloudMailDomains
        ? body.cloudMailDomains
        : (existing?.cloudMailDomains ?? []);
      const cloudMailDomains = normalizeCloudMailDomains(cloudMailDomainsRaw);
      const hasOwnerMailDomains = Object.prototype.hasOwnProperty.call(
        body,
        "ownerMailDomains",
      );
      const ownerMailDomainsRaw = hasOwnerMailDomains
        ? body.ownerMailDomains
        : (existing?.ownerMailDomains ?? []);
      const ownerMailDomains = normalizeOwnerMailDomains(ownerMailDomainsRaw);
      const normalizeAddonQuota = (
        value: unknown,
        fallback: number | null,
      ): number | null => {
        if (value == null || value === "") return fallback;
        const parsed = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(0, parsed);
      };
      const hasAccountSubmissionAddonDailyQuota = Object.prototype.hasOwnProperty.call(
        body,
        "accountSubmissionAddonDailyQuota",
      );
      const hasAccountSubmissionAddonWeeklyCap = Object.prototype.hasOwnProperty.call(
        body,
        "accountSubmissionAddonWeeklyCap",
      );
      const hasAccountSubmissionAddonMonthlyCap = Object.prototype.hasOwnProperty.call(
        body,
        "accountSubmissionAddonMonthlyCap",
      );
      const accountSubmissionAddonDailyQuota = normalizeAddonQuota(
        hasAccountSubmissionAddonDailyQuota
          ? body.accountSubmissionAddonDailyQuota
          : existing?.accountSubmissionAddonDailyQuota,
        existing?.accountSubmissionAddonDailyQuota ?? 0,
      );
      const accountSubmissionAddonWeeklyCap = normalizeAddonQuota(
        hasAccountSubmissionAddonWeeklyCap
          ? body.accountSubmissionAddonWeeklyCap
          : existing?.accountSubmissionAddonWeeklyCap,
        existing?.accountSubmissionAddonWeeklyCap ?? 0,
      );
      const accountSubmissionAddonMonthlyCap = normalizeAddonQuota(
        hasAccountSubmissionAddonMonthlyCap
          ? body.accountSubmissionAddonMonthlyCap
          : existing?.accountSubmissionAddonMonthlyCap,
        existing?.accountSubmissionAddonMonthlyCap ?? 0,
      );
      const hasAccountCacheSize = Object.prototype.hasOwnProperty.call(
        body,
        "accountCacheSize",
      );
      const hasAccountCacheRefreshSeconds = Object.prototype.hasOwnProperty.call(
        body,
        "accountCacheRefreshSeconds",
      );
      const accountCacheSizeRaw = hasAccountCacheSize
        ? body.accountCacheSize
        : existing?.accountCacheSize;
      const accountCacheRefreshSecondsRaw = hasAccountCacheRefreshSeconds
        ? body.accountCacheRefreshSeconds
        : existing?.accountCacheRefreshSeconds;
      const accountCacheSize = normalizeAccountCacheSize(accountCacheSizeRaw);
      const accountCacheRefreshSeconds = normalizeAccountCacheRefreshSeconds(
        accountCacheRefreshSecondsRaw,
      );
      const hasMaxAttemptCount = Object.prototype.hasOwnProperty.call(
        body,
        "maxAttemptCount",
      );
      const maxAttemptCountRaw = hasMaxAttemptCount
        ? body.maxAttemptCount
        : existing?.maxAttemptCount;
      const maxAttemptCount = normalizeMaxAttemptCount(maxAttemptCountRaw);
      const hasUserRpmLimit = Object.prototype.hasOwnProperty.call(
        body,
        "userRpmLimit",
      );
      const userRpmLimitRaw = hasUserRpmLimit
        ? body.userRpmLimit
        : existing?.userRpmLimit;
      const userRpmLimit = normalizeUserRpmLimit(userRpmLimitRaw);
      const hasUserMaxInFlight = Object.prototype.hasOwnProperty.call(
        body,
        "userMaxInFlight",
      );
      const userMaxInFlightRaw = hasUserMaxInFlight
        ? body.userMaxInFlight
        : existing?.userMaxInFlight;
      const userMaxInFlight = normalizeUserMaxInFlight(userMaxInFlightRaw);
      const hasCheckInRewardMin = Object.prototype.hasOwnProperty.call(
        body,
        "checkInRewardMin",
      );
      const hasCheckInRewardMax = Object.prototype.hasOwnProperty.call(
        body,
        "checkInRewardMax",
      );
      const checkInRewardMinRaw = hasCheckInRewardMin
        ? body.checkInRewardMin
        : existing?.checkInRewardMin;
      const checkInRewardMaxRaw = hasCheckInRewardMax
        ? body.checkInRewardMax
        : existing?.checkInRewardMax;
      let checkInRewardMin = normalizeCheckInReward(
        checkInRewardMinRaw,
        existing?.checkInRewardMin ?? DEFAULT_CHECK_IN_REWARD_MIN,
      );
      let checkInRewardMax = normalizeCheckInReward(
        checkInRewardMaxRaw,
        existing?.checkInRewardMax ?? DEFAULT_CHECK_IN_REWARD_MAX,
      );
      if (checkInRewardMin > checkInRewardMax) {
        const swap = checkInRewardMin;
        checkInRewardMin = checkInRewardMax;
        checkInRewardMax = swap;
      }
      const openaiModelsRaw = Array.isArray(body.openaiModels)
        ? body.openaiModels.filter(
            (item): item is Record<string, unknown> =>
              typeof item === "object" && item !== null,
          )
        : null;

      let row = await upsertSystemSettings({
        openaiApiUserAgent,
        openaiClientVersion,
        inboxTranslationModel,
        cloudMailDomains,
        ownerMailDomains,
        accountSubmissionAddonDailyQuota,
        accountSubmissionAddonWeeklyCap,
        accountSubmissionAddonMonthlyCap,
        accountCacheSize,
        accountCacheRefreshSeconds,
        maxAttemptCount,
        userRpmLimit,
        userMaxInFlight,
        checkInRewardMin,
        checkInRewardMax,
      });
      applyOpenAIAccountCacheOptionsFromSettings(row);
      await ensureOpenAIAccountsLruLoaded(true);
      if (openaiModelsRaw) {
        row = await updateSystemSettingsOpenAIModels(
          sanitizeOpenAIModelsForStorage(openaiModelsRaw),
        );
        setOpenAIModelsCache(
          (row.openaiModels ?? []) as Array<Record<string, unknown>>,
          row.openaiModelsUpdatedAt ?? null,
        );
      }
      invalidateOpenAIApiRuntimeConfigCache();
      const runtimeConfig = await getOpenAIApiRuntimeConfig();

      res.json({
        openaiApiUserAgent: row.openaiApiUserAgent,
        openaiClientVersion: row.openaiClientVersion,
        inboxTranslationModel: row.inboxTranslationModel ?? null,
        cloudMailDomains: row.cloudMailDomains ?? [],
        ownerMailDomains: row.ownerMailDomains ?? [],
        accountSubmissionAddonDailyQuota:
          row.accountSubmissionAddonDailyQuota ?? null,
        accountSubmissionAddonWeeklyCap:
          row.accountSubmissionAddonWeeklyCap ?? null,
        accountSubmissionAddonMonthlyCap:
          row.accountSubmissionAddonMonthlyCap ?? null,
        accountCacheSize: row.accountCacheSize ?? null,
        accountCacheRefreshSeconds: row.accountCacheRefreshSeconds ?? null,
        maxAttemptCount: row.maxAttemptCount ?? null,
        userRpmLimit: row.userRpmLimit ?? null,
        userMaxInFlight: row.userMaxInFlight ?? null,
        checkInRewardMin: row.checkInRewardMin ?? null,
        checkInRewardMax: row.checkInRewardMax ?? null,
        effectiveMaxAttemptCount: upstreamRetryConfig.maxAttemptCount,
        effectiveUserRpmLimit: requestRateLimitConfig.userRpmLimit,
        effectiveUserMaxInFlight: requestRateLimitConfig.userMaxInFlight,
        effectiveCheckInRewardMin:
          row.checkInRewardMin ?? DEFAULT_CHECK_IN_REWARD_MIN,
        effectiveCheckInRewardMax:
          row.checkInRewardMax ?? DEFAULT_CHECK_IN_REWARD_MAX,
        effectiveAccountCacheSize: openAIAccountsLruCache.maxSize,
        effectiveAccountCacheRefreshSeconds:
          openAIAccountsLruCache.refreshSeconds,
        openaiModels: openAIModelsCache.loaded
          ? openAIModelsCache.models
          : ((row.openaiModels ?? []) as Array<Record<string, unknown>>),
        openaiModelsUpdatedAt: openAIModelsCache.loaded
          ? openAIModelsCache.updatedAt
          : (row.openaiModelsUpdatedAt ?? null),
        effectiveOpenAIApiUserAgent: runtimeConfig.userAgent,
        effectiveOpenAIClientVersion: runtimeConfig.clientVersion,
        updatedAt: row.updatedAt,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to update system settings",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post(
    "/api/system-settings/openai-models/refresh",
    async (_req: Request, res: Response) => {
      const startedAt = Date.now();
      try {
        await ensureDatabaseSchema();
        const runtimeConfig = await getOpenAIApiRuntimeConfig();
        const [openaiAccount, teamAccount] = await Promise.all([
          getRandomOpenAIModelRefreshAccount(),
          getRandomTeamOwnerModelRefreshAccount(),
        ]);
        if (!openaiAccount && !teamAccount) {
          res.status(400).json({
            ok: false,
            durationMs: Date.now() - startedAt,
            error:
              "No available OpenAI account or team owner account with usable accessToken",
          });
          return;
        }
        if (openaiAccount) {
          console.log(
            `[system-settings] refreshing OpenAI models with openai account email=${openaiAccount.email} id=${openaiAccount.id}`,
          );
        }
        if (teamAccount) {
          console.log(
            `[system-settings] refreshing OpenAI models with team owner email=${teamAccount.email} id=${teamAccount.id} planType=${teamAccount.planType ?? "null"} workspaceName=${teamAccount.workspaceName ?? "null"}`,
          );
        }

        const modelResponses = await Promise.all([
          openaiAccount
            ? getCodexModels({
                accessToken: openaiAccount.accessToken,
                clientVersion: MODELS_REFRESH_CLIENT_VERSION,
                userAgent: runtimeConfig.userAgent,
              })
            : Promise.resolve(null),
          teamAccount
            ? getCodexModels({
                accessToken: teamAccount.accessToken,
                clientVersion: MODELS_REFRESH_CLIENT_VERSION,
                userAgent: runtimeConfig.userAgent,
              })
            : Promise.resolve(null),
        ]);
        const mergedBySlug = new Map<string, Record<string, unknown>>();
        for (const modelsRes of modelResponses) {
          const models = Array.isArray(modelsRes?.models) ? modelsRes.models : [];
          for (const model of models) {
            if (!model || typeof model !== "object") continue;
            const slug =
              typeof (model as Record<string, unknown>).slug === "string"
                ? ((model as Record<string, unknown>).slug as string).trim()
                : "";
            if (!slug || mergedBySlug.has(slug)) continue;
            mergedBySlug.set(slug, model);
          }
        }
        const models = [...mergedBySlug.values()];
        const existingSettings = await getSystemSettings();
        const merged = mergeModelPricesBySlug(
          (existingSettings?.openaiModels ?? []) as Array<Record<string, unknown>>,
          models,
        );
        const sanitizedModels = sanitizeOpenAIModelsForStorage(merged);
        const saved = await updateSystemSettingsOpenAIModels(sanitizedModels);
        setOpenAIModelsCache(
          (saved.openaiModels ?? []) as Array<Record<string, unknown>>,
          saved.openaiModelsUpdatedAt ?? null,
        );

        res.json({
          ok: true,
          durationMs: Date.now() - startedAt,
          fetchedBy: [openaiAccount?.email, teamAccount?.email].filter(
            (item): item is string =>
              typeof item === "string" && item.length > 0,
          ),
          modelSources: {
            openai: openaiAccount?.email ?? null,
            team: teamAccount?.email ?? null,
          },
          clientVersion: MODELS_REFRESH_CLIENT_VERSION,
          modelCount: sanitizedModels.length,
          openaiModels: saved.openaiModels ?? [],
          openaiModelsUpdatedAt: saved.openaiModelsUpdatedAt,
          updatedAt: saved.updatedAt,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
