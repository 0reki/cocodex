import type { Express, Request, Response } from "express";

import type {
  ApiKeyRecord,
  PortalUserRecord,
} from "../../../database/index.ts";
import type { PortalPrincipal } from "../../services/auth/auth-services.ts";
import type { createCodexClientSessionStore } from "../../services/auth/codex-client-session.ts";

type CodexClientSessionStore = ReturnType<typeof createCodexClientSessionStore>;

function stringField(body: unknown, key: string) {
  if (!body || typeof body !== "object") return "";
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function queryField(req: Request, key: string) {
  const value = req.query[key];
  return typeof value === "string" ? value.trim() : "";
}

function frontendLoginRedirect(nextPath: string) {
  const base = (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  const loginPath = `/login?next=${encodeURIComponent(nextPath)}`;
  return base ? `${base}${loginPath}` : loginPath;
}

export function registerCodexClientProtocolRoutes(
  app: Express,
  deps: { sessions: CodexClientSessionStore },
) {
  app.post("/api/accounts/deviceauth/usercode", (_req: Request, res: Response) => {
    res.json(deps.sessions.createDeviceCode());
  });

  app.post("/api/accounts/deviceauth/token", (req: Request, res: Response) => {
    const result = deps.sessions.pollDeviceToken(
      stringField(req.body, "device_auth_id"),
      stringField(req.body, "user_code"),
    );
    if (result.status === "complete") {
      res.json({
        authorization_code: result.authorization_code,
        code_challenge: result.code_challenge,
        code_verifier: result.code_verifier,
      });
      return;
    }
    if (result.status === "pending") {
      res.status(403).json({ error: "authorization_pending" });
      return;
    }
    res.status(404).json({ error: "invalid_device_code" });
  });

  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const next = `/oauth/complete${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
    res.redirect(frontendLoginRedirect(next));
  });

  app.get("/codex/device", (req: Request, res: Response) => {
    const userCode = queryField(req, "user_code");
    const next = userCode
      ? `/codex/device?user_code=${encodeURIComponent(userCode)}`
      : "/codex/device";
    res.redirect(frontendLoginRedirect(next));
  });

  app.post("/oauth/token", (req: Request, res: Response) => {
    const grantType = stringField(req.body, "grant_type");
    if (grantType === "refresh_token") {
      const tokens = deps.sessions.refresh(stringField(req.body, "refresh_token"));
      if (!tokens) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      res.json(tokens);
      return;
    }

    const tokens = deps.sessions.exchangeAuthorizationCode({
      code: stringField(req.body, "code"),
      redirectUri: stringField(req.body, "redirect_uri"),
      codeVerifier: stringField(req.body, "code_verifier"),
    });
    if (!tokens) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    res.json(tokens);
  });

  app.post("/oauth/revoke", (req: Request, res: Response) => {
    deps.sessions.revoke(
      stringField(req.body, "token") || stringField(req.body, "refresh_token"),
    );
    res.status(200).json({ revoked: true });
  });

  app.get("/deviceauth/callback", (_req: Request, res: Response) => {
    res.status(204).end();
  });
}

export function registerCodexClientPortalRoutes(
  app: Express,
  deps: {
    sessions: CodexClientSessionStore;
    getPortalPrincipalFromLocals: (res: Response) => PortalPrincipal | null;
    getPortalUserById: (id: string) => Promise<PortalUserRecord | null>;
    resolveOwnedApiKey: (user: PortalUserRecord) => Promise<ApiKeyRecord>;
  },
) {
  async function resolveSessionUser(res: Response) {
    const principal = deps.getPortalPrincipalFromLocals(res);
    if (!principal) {
      throw new Error("Unauthorized");
    }
    const user = await deps.getPortalUserById(principal.id);
    if (!user?.enabled) {
      throw new Error("User is disabled or unavailable");
    }
    return user;
  }

  app.post("/api/codex-client/authorize", async (req: Request, res: Response) => {
    try {
      const redirectUri = stringField(req.body, "redirectUri");
      const codeChallenge = stringField(req.body, "codeChallenge");
      const state = stringField(req.body, "state");
      if (!redirectUri || !codeChallenge) {
        res.status(400).json({
          error: {
            message: "Missing OAuth authorize parameters",
            type: "invalid_request_error",
            code: "invalid_request",
          },
        });
        return;
      }
      const user = await resolveSessionUser(res);
      const apiKey = await deps.resolveOwnedApiKey(user);
      const code = deps.sessions.createBrowserAuthorization({
        apiKey,
        email: `${user.username}@cocodex.local`,
        codeChallenge,
        redirectUri,
      });
      const next = new URL(redirectUri);
      next.searchParams.set("code", code);
      if (state) next.searchParams.set("state", state);
      res.json({ redirectTo: next.toString() });
    } catch (error) {
      res.status(401).json({
        error: {
          message: error instanceof Error ? error.message : "Unauthorized",
          type: "invalid_request_error",
          code: "unauthorized",
        },
      });
    }
  });

  app.post("/api/codex-client/device/approve", async (req: Request, res: Response) => {
    try {
      const userCode = stringField(req.body, "userCode");
      if (!userCode) {
        res.status(400).json({
          error: {
            message: "Device code is required",
            type: "invalid_request_error",
            code: "invalid_request",
          },
        });
        return;
      }
      const user = await resolveSessionUser(res);
      const apiKey = await deps.resolveOwnedApiKey(user);
      deps.sessions.approveDevice({
        userCode,
        apiKey,
        email: `${user.username}@cocodex.local`,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({
        error: {
          message: error instanceof Error ? error.message : "Failed to approve device login",
          type: "invalid_request_error",
          code: "device_approval_failed",
        },
      });
    }
  });
}
