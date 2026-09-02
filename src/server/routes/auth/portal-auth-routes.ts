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
  verifyPortalToken,
} from "../../auth/portal-auth.ts";

function publicUser(user: {
  id: string;
  username: string;
  role: "admin" | "user";
  enabled: boolean;
}) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
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
      if (
        !user?.enabled ||
        !(await verifyPassword(password, user.passwordHash))
      ) {
        res.status(401).json({ ok: false, error: "Invalid credentials" });
        return;
      }

      res.json({
        ok: true,
        user: publicUser(user),
        ...createPortalTokens({
          userId: user.id,
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
      const claims = verifyPortalToken(refreshToken, "refresh");
      if (!claims) {
        res.status(401).json({ ok: false, error: "Invalid refresh token" });
        return;
      }

      await ensureDatabaseSchema();
      const user = await getPortalUserById(claims.sub);
      if (!user?.enabled) {
        res.status(401).json({ ok: false, error: "User is unavailable" });
        return;
      }

      res.json({
        ok: true,
        user: publicUser(user),
        ...createPortalTokens({
          userId: user.id,
        }),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
