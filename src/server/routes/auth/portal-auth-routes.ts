import type { Express, Request, Response } from "express";

import {
  ensureDatabaseSchema,
  getPortalUserSpendAllowance,
  getPortalUserById,
  getPortalUserByUsername,
  inspectPortalInvitation,
  PortalInvitationError,
  registerPortalUserWithInvitation,
} from "../../../database/index.ts";
import {
  createPortalTokens,
  ensureBootstrapAdminUser,
  getPortalPasswordValidationError,
  hashPassword,
  hashPortalInvitationToken,
  verifyPassword,
  verifyPortalToken,
} from "../../auth/portal-auth.ts";
import type { ServerServices } from "../../bootstrap/services.ts";

const REFRESH_TOKEN_COOKIE = "cocodex.refresh_token";

function refreshTokenCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/api/auth",
  };
}

function issuePortalTokens(res: Response, userId: string) {
  const { accessToken, refreshToken } = createPortalTokens({ userId });
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken.token, {
    ...refreshTokenCookieOptions(),
    expires: new Date(refreshToken.expiresAt * 1000),
  });
  return { accessToken };
}

function readCookie(req: Request, name: string) {
  const cookieHeader = req.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return "";
}

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

export function registerPortalAuthRoutes(
  app: Express,
  deps: Pick<ServerServices, "primeUserBillingAllowance">,
) {
  app.get(
    "/api/auth/invitations/:token",
    async (req: Request, res: Response) => {
      res.setHeader("cache-control", "no-store");
      try {
        await ensureDatabaseSchema();
        const token = String(req.params.token ?? "").trim();
        if (!token) {
          res.status(400).json({ ok: false, error: "Invitation token is required" });
          return;
        }
        const result = await inspectPortalInvitation(
          hashPortalInvitationToken(token),
        );
        if (!result.valid) {
          res.status(410).json({ ok: false, error: result.reason });
          return;
        }
        res.json({
          ok: true,
          expiresAt: result.invitation.expiresAt,
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      await ensureDatabaseSchema();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const inviteToken =
        typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
      const username =
        typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!inviteToken || !username || !password) {
        res.status(400).json({
          ok: false,
          error: "inviteToken, username and password are required",
        });
        return;
      }

      const tokenHash = hashPortalInvitationToken(inviteToken);
      const invitation = await inspectPortalInvitation(tokenHash);
      if (!invitation.valid) {
        res.status(410).json({ ok: false, error: invitation.reason });
        return;
      }
      const passwordError = getPortalPasswordValidationError(password);
      if (passwordError) {
        res.status(400).json({ ok: false, error: passwordError });
        return;
      }

      const user = await registerPortalUserWithInvitation({
        tokenHash,
        username,
        passwordHash: await hashPassword(password),
      });
      deps.primeUserBillingAllowance(user.id, 0);
      res.status(201).json({
        ok: true,
        user: publicUser(user),
        ...issuePortalTokens(res, user.id),
      });
    } catch (error) {
      if (error instanceof PortalInvitationError) {
        res.status(error.code === "user_limit_reached" ? 409 : 410).json({
          ok: false,
          error: error.code,
        });
        return;
      }
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
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      await ensureBootstrapAdminUser();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const username =
        typeof body.username === "string"
          ? body.username.trim().toLowerCase()
          : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (getPortalPasswordValidationError(password)) {
        res.status(401).json({ ok: false, error: "Invalid credentials" });
        return;
      }
      const user = username ? await getPortalUserByUsername(username) : null;
      if (
        !user?.enabled ||
        !(await verifyPassword(password, user.passwordHash))
      ) {
        res.status(401).json({ ok: false, error: "Invalid credentials" });
        return;
      }
      const allowance = await getPortalUserSpendAllowance(user.id);
      deps.primeUserBillingAllowance(user.id, allowance.balance);

      res.json({
        ok: true,
        user: publicUser(user),
        ...issuePortalTokens(res, user.id),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/auth/refresh", async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      const refreshToken = readCookie(req, REFRESH_TOKEN_COOKIE);
      const claims = verifyPortalToken(refreshToken, "refresh");
      if (!claims) {
        res.clearCookie(REFRESH_TOKEN_COOKIE, refreshTokenCookieOptions());
        res.status(401).json({ ok: false, error: "Invalid refresh token" });
        return;
      }

      await ensureDatabaseSchema();
      const user = await getPortalUserById(claims.sub);
      if (!user?.enabled) {
        res.clearCookie(REFRESH_TOKEN_COOKIE, refreshTokenCookieOptions());
        res.status(401).json({ ok: false, error: "User is unavailable" });
        return;
      }
      const allowance = await getPortalUserSpendAllowance(user.id);
      deps.primeUserBillingAllowance(user.id, allowance.balance);

      res.json({
        ok: true,
        user: publicUser(user),
        ...issuePortalTokens(res, user.id),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/auth/logout", (_req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    res.clearCookie(REFRESH_TOKEN_COOKIE, refreshTokenCookieOptions());
    res.json({ ok: true });
  });
}
