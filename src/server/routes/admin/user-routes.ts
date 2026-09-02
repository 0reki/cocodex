import type { Express, Request, Response } from "express";
import type {
  createPortalUser,
  listPortalUsers,
  setPortalUserEnabledById,
  updatePortalUsernameById,
  updatePortalUserPasswordById,
} from "../../../database/index.ts";
import { hashPassword } from "../../auth/portal-auth.ts";
import type { ServerServices } from "../../bootstrap/services.ts";

type UserRouteDependencies = Pick<
  ServerServices,
  "getPortalPrincipalFromLocals" | "invalidateApiKeyAuthCacheByOwnerUserId"
> & {
  listPortalUsers: typeof listPortalUsers;
  createPortalUser: typeof createPortalUser;
  updatePortalUsernameById: typeof updatePortalUsernameById;
  updatePortalUserPasswordById: typeof updatePortalUserPasswordById;
  setPortalUserEnabledById: typeof setPortalUserEnabledById;
};

function publicUser(user: {
  id: string;
  username: string;
  role: "admin" | "user";
  enabled: boolean;
  balance?: number;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    ...(typeof user.balance === "number" ? { balance: user.balance } : {}),
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
  res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function registerUserRoutes(
  app: Express,
  deps: UserRouteDependencies,
) {
  app.get("/api/users", async (_req: Request, res: Response) => {
    try {
      const users = await deps.listPortalUsers();
      res.json({ items: users.map(publicUser), count: users.length });
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
      const user = await deps.createPortalUser({
        username,
        passwordHash: await hashPassword(password),
        role: "user",
        enabled: true,
        balance: 0,
      });
      res.status(201).json({ ok: true, user: publicUser(user) });
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
