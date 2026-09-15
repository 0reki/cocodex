import type { Express, Request, Response } from "express";
import type {
  createPortalInvitation,
  createPortalUser,
  listApiKeys,
  listPortalUserUpstreamAssignments,
  listPortalUsers,
  setPortalUserUpstreamAssignment,
  setPortalUserEnabledById,
  updatePortalUsernameById,
  updatePortalUserPasswordById,
} from "../../../database/index.ts";
import {
  PortalInvitationError,
  PortalUserSeatLimitError,
} from "../../../database/index.ts";
import {
  createPortalInvitationToken,
  getPortalPasswordValidationError,
  hashPassword,
  hashPortalInvitationToken,
} from "../../auth/portal-auth.ts";
import type { ServerServices } from "../../bootstrap/services.ts";

type UserRouteDependencies = Pick<
  ServerServices,
  | "getPortalPrincipalFromLocals"
  | "getAssignedSourceAccount"
  | "getUserUpstreamQuotaSummary"
  | "hydrateUpstreamQuotaCache"
  | "invalidateActiveSourceAccount"
  | "invalidateApiKeyAuthCacheByOwnerUserId"
  | "cacheApiKey"
> & {
  listPortalUsers: typeof listPortalUsers;
  createPortalUser: typeof createPortalUser;
  createPortalInvitation: typeof createPortalInvitation;
  listApiKeys: typeof listApiKeys;
  listPortalUserUpstreamAssignments: typeof listPortalUserUpstreamAssignments;
  setPortalUserUpstreamAssignment: typeof setPortalUserUpstreamAssignment;
  updatePortalUsernameById: typeof updatePortalUsernameById;
  updatePortalUserPasswordById: typeof updatePortalUserPasswordById;
  setPortalUserEnabledById: typeof setPortalUserEnabledById;
};

function publicUser(
  user: {
    id: string;
    username: string;
    role: "admin" | "user";
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  },
  sourceAccountId?: string | null,
) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    ...(sourceAccountId !== undefined ? { sourceAccountId } : {}),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function getIdParam(req: Request) {
  const value = req.params.id;
  return typeof value === "string" ? value.trim() : "";
}

function sendUserWriteError(res: Response, error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  if (code === "23505") {
    res.status(409).json({ ok: false, error: "Username already exists" });
    return;
  }
  if (error instanceof PortalUserSeatLimitError) {
    res.status(409).json({ ok: false, error: "user_limit_reached" });
    return;
  }
  res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function registerUserRoutes(
  app: Express,
  deps: UserRouteDependencies,
) {
  app.get("/api/my-usage", async (_req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      const principal = deps.getPortalPrincipalFromLocals(res);
      if (!principal) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const sourceAccount = await deps.getAssignedSourceAccount(principal.id);
      if (!sourceAccount?.accessToken) {
        res.status(403).json({
          ok: false,
          error: {
            message: "尚未分配上游账号",
            type: "invalid_request_error",
            code: "upstream_account_unassigned",
          },
        });
        return;
      }
      const summary = await deps.getUserUpstreamQuotaSummary({
        sourceAccount,
        ownerUserId: principal.id,
      });
      const [users, assignments] = await Promise.all([
        deps.listPortalUsers(),
        deps.listPortalUserUpstreamAssignments(),
      ]);
      const assignedUserIds = new Set(
        assignments
          .filter(
            (assignment) => assignment.sourceAccountId === sourceAccount.id,
          )
          .map((assignment) => assignment.ownerUserId),
      );
      res.json({
        ok: true,
        ...summary,
        users: users
          .filter((user) => assignedUserIds.has(user.id))
          .map((user) => publicUser(user)),
      });
    } catch (error) {
      res.status(502).json({
        ok: false,
        error: "upstream_usage_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/user-invitations", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      const principal = deps.getPortalPrincipalFromLocals(res);
      if (!principal) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const ttlSecondsRaw = Number(
        process.env.PORTAL_INVITATION_TTL_SECONDS ?? 7 * 24 * 60 * 60,
      );
      const ttlSeconds =
        Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0
          ? Math.floor(ttlSecondsRaw)
          : 7 * 24 * 60 * 60;
      const token = createPortalInvitationToken();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const invitation = await deps.createPortalInvitation({
        tokenHash: hashPortalInvitationToken(token),
        invitedByUserId: principal.id,
        expiresAt,
      });
      const registrationPath = `/register?invite=${encodeURIComponent(token)}`;
      const configuredBaseUrl = process.env.PUBLIC_APP_URL?.trim() ?? "";
      const requestOrigin = req.get("origin")?.trim() ?? "";
      const fallbackOrigin = `${req.protocol}://${req.get("host")}`;
      const baseUrl = configuredBaseUrl || requestOrigin || fallbackOrigin;
      res.status(201).json({
        ok: true,
        invitation,
        registrationPath,
        registrationUrl: new URL(registrationPath, baseUrl).toString(),
      });
    } catch (error) {
      if (error instanceof PortalInvitationError) {
        res.status(409).json({ ok: false, error: error.code });
        return;
      }
      sendUserWriteError(res, error);
    }
  });

  app.get("/api/users", async (_req: Request, res: Response) => {
    try {
      const [users, assignments] = await Promise.all([
        deps.listPortalUsers(),
        deps.listPortalUserUpstreamAssignments(),
      ]);
      const sourceAccountIdByUserId = new Map(
        assignments.map((assignment) => [
          assignment.ownerUserId,
          assignment.sourceAccountId,
        ]),
      );
      res.json({
        items: users.map((user) =>
          publicUser(user, sourceAccountIdByUserId.get(user.id) ?? null),
        ),
        count: users.length,
      });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });

  app.put("/api/users/:id/upstream", async (req: Request, res: Response) => {
    try {
      const ownerUserId = getIdParam(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        body.sourceAccountId !== null &&
        typeof body.sourceAccountId !== "string"
      ) {
        res.status(400).json({
          ok: false,
          error: "sourceAccountId must be a string or null",
        });
        return;
      }
      const sourceAccountId =
        typeof body.sourceAccountId === "string"
          ? body.sourceAccountId.trim() || null
          : null;
      if (!ownerUserId) {
        res.status(400).json({ ok: false, error: "id param is required" });
        return;
      }
      const assignment = await deps.setPortalUserUpstreamAssignment({
        ownerUserId,
        sourceAccountId,
      });
      if (!assignment) {
        res.status(404).json({
          ok: false,
          error: "upstream_account_unavailable",
        });
        return;
      }
      const assignedAccounts = await deps.invalidateActiveSourceAccount();
      await deps.hydrateUpstreamQuotaCache({
        sourceAccounts: assignedAccounts.map((item) => item.account),
      });
      res.json({ ok: true, assignment });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });

  app.post("/api/users", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username =
        typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username || !password) {
        res.status(400).json({
          ok: false,
          error: "username and password are required",
        });
        return;
      }
      const passwordError = getPortalPasswordValidationError(password);
      if (passwordError) {
        res.status(400).json({ ok: false, error: passwordError });
        return;
      }
      const user = await deps.createPortalUser({
        username,
        passwordHash: await hashPassword(password),
        role: "user",
        enabled: true,
      });
      res.status(201).json({ ok: true, user: publicUser(user, null) });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });

  app.put("/api/users/:id/username", async (req: Request, res: Response) => {
    try {
      const id = getIdParam(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username =
        typeof body.username === "string" ? body.username.trim() : "";
      if (!id || !username) {
        res
          .status(400)
          .json({ ok: false, error: "id and username are required" });
        return;
      }
      const user = await deps.updatePortalUsernameById(id, username);
      if (!user) {
        res.status(404).json({ ok: false, error: "User not found" });
        return;
      }
      res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });

  app.put("/api/users/:id/password", async (req: Request, res: Response) => {
    try {
      const id = getIdParam(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const password = typeof body.password === "string" ? body.password : "";
      if (!id || !password) {
        res
          .status(400)
          .json({ ok: false, error: "id and password are required" });
        return;
      }
      const passwordError = getPortalPasswordValidationError(password);
      if (passwordError) {
        res.status(400).json({ ok: false, error: passwordError });
        return;
      }
      const updated = await deps.updatePortalUserPasswordById(
        id,
        await hashPassword(password),
      );
      if (!updated) {
        res.status(404).json({ ok: false, error: "User not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });

  app.post("/api/users/:id/enable", async (req: Request, res: Response) => {
    try {
      const id = getIdParam(req);
      if (!id) {
        res.status(400).json({ ok: false, error: "id is required" });
        return;
      }
      const user = await deps.setPortalUserEnabledById(id, true);
      if (!user) {
        res.status(404).json({ ok: false, error: "User not found" });
        return;
      }
      deps.invalidateApiKeyAuthCacheByOwnerUserId(id);
      const apiKeys = await deps.listApiKeys({ ownerUserId: id });
      for (const apiKey of apiKeys) deps.cacheApiKey(apiKey);
      res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });

  app.post("/api/users/:id/disable", async (req: Request, res: Response) => {
    try {
      const id = getIdParam(req);
      if (!id) {
        res.status(400).json({ ok: false, error: "id is required" });
        return;
      }
      const principal = deps.getPortalPrincipalFromLocals(res);
      if (principal?.id.toLowerCase() === id.toLowerCase()) {
        res.status(400).json({
          ok: false,
          error: "The current user cannot disable itself",
        });
        return;
      }
      const user = await deps.setPortalUserEnabledById(id, false);
      if (!user) {
        res.status(404).json({ ok: false, error: "User not found" });
        return;
      }
      deps.invalidateApiKeyAuthCacheByOwnerUserId(id);
      res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
      sendUserWriteError(res, error);
    }
  });
}
