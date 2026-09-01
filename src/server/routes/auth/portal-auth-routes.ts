import type { Express, Request, Response } from "express";

import {
  ensureDatabaseSchema,
  getPortalUserById,
  getPortalUserByUsername,
} from "../../../database/index.ts";
import {
  createPortalTokens,
  ensureBootstrapAdminUser,
  verifyPassword,
  verifyPortalAccessToken,
  verifyPortalToken,
} from "../../auth/portal-auth.ts";

function getBearerToken(req: Request) {
  const authorization = req.header("authorization")?.trim() ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function publicUser(user: {
  id: string;
  username: string;
  role: "admin" | "user";
  enabled: boolean;
  mustSetup: boolean;
  avatarUrl: string | null;
}) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    mustSetup: user.mustSetup,
    avatarUrl: user.avatarUrl,
  };
}

export function registerPortalAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      await ensureBootstrapAdminUser();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username =
        typeof body.username === "string"
          ? body.username.trim().toLowerCase()
          : "";
      const password = typeof body.password === "string" ? body.password : "";
      const user = username ? await getPortalUserByUsername(username) : null;
      if (!user?.enabled || !verifyPassword(password, user.passwordHash)) {
        res.status(401).json({ ok: false, error: "Invalid credentials" });
        return;
      }

      res.json({
        ok: true,
        user: publicUser(user),
        ...createPortalTokens({
          userId: user.id,
          username: user.username,
          role: user.role,
          mustSetup: user.mustSetup,
        }),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/auth/refresh", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const refreshToken =
        typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
      const session = verifyPortalToken(refreshToken, "refresh");
      if (!session) {
        res.status(401).json({ ok: false, error: "Invalid refresh token" });
        return;
      }

      await ensureDatabaseSchema();
      const user = await getPortalUserById(session.sub);
      if (!user?.enabled) {
        res.status(401).json({ ok: false, error: "User is unavailable" });
        return;
      }

      res.json({
        ok: true,
        user: publicUser(user),
        ...createPortalTokens({
          userId: user.id,
          username: user.username,
          role: user.role,
          mustSetup: user.mustSetup,
        }),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/auth/session", async (req: Request, res: Response) => {
    try {
      const session = verifyPortalAccessToken(getBearerToken(req));
      if (!session) {
        res.status(401).json({ authed: false, user: null });
        return;
      }

      await ensureDatabaseSchema();
      const user = await getPortalUserById(session.sub);
      if (!user?.enabled) {
        res.status(401).json({ authed: false, user: null });
        return;
      }
      res.json({ authed: true, user: publicUser(user) });
    } catch (error) {
      res.status(500).json({
        authed: false,
        user: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
