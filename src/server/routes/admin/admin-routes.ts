import type { Express, Request, Response } from "express";
import type {
  activateOpenAIAccountByEmail,
  createApiKey,
  deleteApiKeyById,
  deleteOpenAIAccountByEmail,
  deleteOpenAIAccountsByEmails,
  disableOpenAIAccountByEmail,
  disableOpenAIAccountsByEmails,
  getOpenAIAccountByEmail,
  listApiKeys,
  listOpenAIAccountsPage,
  normalizeOpenAIAccountStatus,
  OpenAIAccountRecord,
  updateApiKeyById,
  upsertOpenAIAccount,
} from "../../../database/index.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import type { generateApiKeyValue } from "../../utils/index.ts";
import type {
  pollCodexDeviceAuth,
  requestCodexDeviceCode,
} from "../../../openai-api/index.ts";
import { formatUsdAmount, parseUsdAmount } from "../../../shared/usd.ts";

type AdminRouteDependencies = Pick<
  ServerServices,
  | "getPortalPrincipalFromLocals"
  | "cacheApiKey"
  | "invalidateApiKeyAuthCacheByToken"
  | "invalidateActiveSourceAccount"
> & {
  listOpenAIAccountsPage: typeof listOpenAIAccountsPage;
  listApiKeys: typeof listApiKeys;
  generateApiKeyValue: typeof generateApiKeyValue;
  createApiKey: typeof createApiKey;
  deleteApiKeyById: typeof deleteApiKeyById;
  updateApiKeyById: typeof updateApiKeyById;
  getOpenAIAccountByEmail: typeof getOpenAIAccountByEmail;
  deleteOpenAIAccountByEmail: typeof deleteOpenAIAccountByEmail;
  deleteOpenAIAccountsByEmails: typeof deleteOpenAIAccountsByEmails;
  disableOpenAIAccountByEmail: typeof disableOpenAIAccountByEmail;
  activateOpenAIAccountByEmail: typeof activateOpenAIAccountByEmail;
  disableOpenAIAccountsByEmails: typeof disableOpenAIAccountsByEmails;
  normalizeOpenAIAccountStatus: typeof normalizeOpenAIAccountStatus;
  upsertOpenAIAccount: typeof upsertOpenAIAccount;
  requestCodexDeviceCode: typeof requestCodexDeviceCode;
  pollCodexDeviceAuth: typeof pollCodexDeviceAuth;
};

function publicOpenAIAccount(account: OpenAIAccountRecord) {
  return {
    id: account.id,
    email: account.email,
    accountId: account.accountId,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function publicApiKey(apiKey: Awaited<ReturnType<typeof createApiKey>>) {
  return {
    ...apiKey,
    quota: apiKey.quota === null ? null : Number(apiKey.quota),
    used: Number(apiKey.used),
  };
}

export function registerAdminRoutes(
  app: Express,
  deps: AdminRouteDependencies,
) {
  const {
    listOpenAIAccountsPage,
    getPortalPrincipalFromLocals,
    listApiKeys,
    cacheApiKey,
    invalidateApiKeyAuthCacheByToken,
    invalidateActiveSourceAccount,
    generateApiKeyValue,
    createApiKey,
    deleteApiKeyById,
    updateApiKeyById,
    getOpenAIAccountByEmail,
    deleteOpenAIAccountByEmail,
    deleteOpenAIAccountsByEmails,
    disableOpenAIAccountByEmail,
    activateOpenAIAccountByEmail,
    disableOpenAIAccountsByEmails,
    normalizeOpenAIAccountStatus,
    upsertOpenAIAccount,
    requestCodexDeviceCode,
    pollCodexDeviceAuth,
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
        items: data.items.map(publicOpenAIAccount),
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
      const principal = getPortalPrincipalFromLocals(res);
      if (!principal) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const items = await listApiKeys({ ownerUserId: principal.id });
      res.json({ items: items.map(publicApiKey), count: items.length });
    } catch (error) {
      res.status(500).json({
        error: "Failed to list API keys",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/api-keys", async (req: Request, res: Response) => {
    try {
      const principal = getPortalPrincipalFromLocals(res);
      if (!principal) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const requesterUserId = principal.id;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ ok: false, error: "name is required" });
        return;
      }
      const quotaInput = body.quota;
      let quota: string | null = null;
      if (!(quotaInput === null || quotaInput === undefined || quotaInput === "")) {
        const quotaAmount = parseUsdAmount(quotaInput);
        if (quotaAmount === null || quotaAmount < 0n) {
          res.status(400).json({ ok: false, error: "quota is invalid" });
          return;
        }
        quota = formatUsdAmount(quotaAmount);
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
      const item = await createApiKey({
        ownerUserId: requesterUserId,
        name,
        apiKey: generateApiKeyValue(),
        quota,
        expiresAt,
      });
      cacheApiKey(item);
      res.status(201).json({ ok: true, item: publicApiKey(item) });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.delete("/api/api-keys/:id", async (req: Request, res: Response) => {
    try {
      const principal = getPortalPrincipalFromLocals(res);
      if (!principal) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const requesterUserId = principal.id;
      const idParam = req.params.id;
      if (typeof idParam !== "string" || !idParam.trim()) {
        res.status(400).json({ ok: false, error: "id param is required" });
        return;
      }
      const deleted = await deleteApiKeyById(idParam, {
        ownerUserId: requesterUserId,
      });
      if (!deleted) {
        res.status(404).json({ ok: false, error: "API key not found" });
        return;
      }
      invalidateApiKeyAuthCacheByToken(deleted.apiKey);
      res.json({ ok: true, deleted: 1 });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.put("/api/api-keys/:id", async (req: Request, res: Response) => {
    try {
      const principal = getPortalPrincipalFromLocals(res);
      if (!principal) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const requesterUserId = principal.id;
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
      let quota: string | null = null;
      if (!(quotaInput === null || quotaInput === undefined || quotaInput === "")) {
        const quotaAmount = parseUsdAmount(quotaInput);
        if (quotaAmount === null || quotaAmount < 0n) {
          res.status(400).json({ ok: false, error: "quota is invalid" });
          return;
        }
        quota = formatUsdAmount(quotaAmount);
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
      cacheApiKey(updated);
      res.json({ ok: true, item: publicApiKey(updated) });
    } catch (error) {
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

      res.json(publicOpenAIAccount(row));
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
      await invalidateActiveSourceAccount();
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
      if (deleted > 0) await invalidateActiveSourceAccount();
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
      await invalidateActiveSourceAccount();
      res.json({ ok: true, updated: 1, status: "disabled" });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/openai-accounts/:email/activate", async (req: Request, res: Response) => {
    try {
      const emailParam = req.params.email;
      if (typeof emailParam !== "string" || !emailParam.trim()) {
        res.status(400).json({ ok: false, error: "email param is required" });
        return;
      }
      const email = decodeURIComponent(emailParam);
      const updated = await activateOpenAIAccountByEmail(email);
      if (!updated) {
        res.status(404).json({ ok: false, error: "Account not found" });
        return;
      }
      await invalidateActiveSourceAccount();
      res.json({ ok: true, updated: 1, status: "active" });
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
      if (updated > 0) await invalidateActiveSourceAccount();
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

  app.post("/api/openai-accounts", async (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const accountId =
        typeof body.accountId === "string" ? body.accountId.trim() : "";
      const idToken =
        typeof body.idToken === "string" ? body.idToken.trim() : "";
      const accessToken =
        typeof body.accessToken === "string" ? body.accessToken.trim() : "";
      const refreshToken =
        typeof body.refreshToken === "string"
          ? body.refreshToken.trim()
          : "";
      const missingFields = [
        ["email", email],
        ["accountId", accountId],
        ["idToken", idToken],
        ["accessToken", accessToken],
        ["refreshToken", refreshToken],
      ]
        .filter(([, value]) => !value)
        .map(([field]) => field);
      if (missingFields.length > 0) {
        res.status(400).json({
          error: `Missing required fields: ${missingFields.join(", ")}`,
        });
        return;
      }

      const statusInput = typeof body.status === "string" ? body.status : "";
      const status = statusInput
        ? normalizeOpenAIAccountStatus(statusInput)
        : null;
      if (statusInput && !status) {
        res.status(400).json({ error: "status is invalid" });
        return;
      }
      const row = await upsertOpenAIAccount({
        email,
        accountId,
        status,
        idToken,
        accessToken,
        refreshToken,
      });
      await invalidateActiveSourceAccount();

      res.status(201).json(publicOpenAIAccount(row));
    } catch (error) {
      res.status(500).json({
        error: "Failed to upsert account",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post(
    "/api/openai-accounts/device-auth/start",
    async (_req: Request, res: Response) => {
      try {
        const deviceCode = await requestCodexDeviceCode();
        res.status(201).json({
          ...deviceCode,
          expiresAt: new Date(
            Date.now() + deviceCode.expiresInSeconds * 1000,
          ).toISOString(),
        });
      } catch (error) {
        res.status(502).json({
          error: "Failed to start OpenAI device authentication",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    "/api/openai-accounts/device-auth/poll",
    async (req: Request, res: Response) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const deviceAuthId =
          typeof body.deviceAuthId === "string" ? body.deviceAuthId.trim() : "";
        const userCode =
          typeof body.userCode === "string" ? body.userCode.trim() : "";
        if (!deviceAuthId || !userCode) {
          res.status(400).json({
            error: "deviceAuthId and userCode are required",
          });
          return;
        }

        const result = await pollCodexDeviceAuth({ deviceAuthId, userCode });
        if (result.status === "pending") {
          res.json(result);
          return;
        }

        const account = await upsertOpenAIAccount({
          email: result.email,
          accountId: result.accountId,
          idToken: result.idToken,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        });
        await invalidateActiveSourceAccount();
        res.status(201).json({
          status: "complete",
          account: publicOpenAIAccount(account),
        });
      } catch (error) {
        res.status(502).json({
          error: "Failed to complete OpenAI device authentication",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

}
