import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import {
  createApiKey,
  getApiKeyByToken,
  getPortalUserById,
  listApiKeys,
  type ApiKeyRecord,
  type PortalUserRecord,
} from "../../database/index.ts";
import { verifyPortalAccessToken } from "../auth/portal-auth.ts";
import { generateApiKeyValue } from "../utils/runtime/env-utils.ts";
import {
  flushResponseSettlements,
  type ResponseSettlement,
} from "../../database/internal/response-settlements.ts";
import { parseUsdAmount } from "../../shared/usd.ts";

const CODEX_CLIENT_API_KEY_NAME = "Codex client";

export type IpcServerOptions = {
  socketPath?: string;
  cacheApiKey?: (apiKey: ApiKeyRecord) => void;
};

export type IpcServerInstance = {
  socketPath: string;
  close: () => Promise<void>;
};

type JsonRpcRequest = {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown } | null;
};

export function getDefaultIpcSocketPath(): string {
  if (process.env.COCODEX_IPC_SOCKET_PATH?.trim()) {
    return process.env.COCODEX_IPC_SOCKET_PATH.trim();
  }
  return path.resolve(process.cwd(), "data", "cocodex-ipc.sock");
}

export function startNodeIpcServer(options: IpcServerOptions = {}): Promise<IpcServerInstance> {
  const socketPath = options.socketPath || getDefaultIpcSocketPath();

  // Ensure parent directory exists
  const socketDir = path.dirname(socketPath);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }

  // Remove existing stale socket if present
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (e) {
      console.warn(`[ipc-server] Failed to remove existing socket at ${socketPath}:`, e);
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const rl = readline.createInterface({
        input: socket,
        crlfDelay: Infinity,
      });

      rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let request: JsonRpcRequest;
        try {
          request = JSON.parse(trimmed);
        } catch {
          const errResp: JsonRpcResponse = {
            id: null,
            error: { code: -32700, message: "Parse error" },
          };
          socket.write(`${JSON.stringify(errResp)}\n`);
          return;
        }

        const reqId = request.id ?? null;
        try {
          const result = await handleRpcMethod(request.method, request.params ?? {}, options);
          // If request had an id, send response
          if (reqId !== null && reqId !== undefined) {
            const resp: JsonRpcResponse = { id: reqId, result, error: null };
            socket.write(`${JSON.stringify(resp)}\n`);
          }
        } catch (error) {
          if (reqId !== null && reqId !== undefined) {
            const message = error instanceof Error ? error.message : String(error);
            const resp: JsonRpcResponse = {
              id: reqId,
              error: { code: -32603, message },
            };
            socket.write(`${JSON.stringify(resp)}\n`);
          }
        }
      });

      socket.on("error", (err) => {
        console.debug("[ipc-server] client socket error:", err.message);
      });
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o700);
      } catch {
        // Ignore chmod errors on Windows or if not permitted
      }
      console.log(`[ipc-server] listening on Unix domain socket: ${socketPath}`);
      resolve({
        socketPath,
        close: () =>
          new Promise((res) => {
            server.close(() => {
              if (fs.existsSync(socketPath)) {
                try {
                  fs.unlinkSync(socketPath);
                } catch {
                  // ignore
                }
              }
              res();
            });
          }),
      });
    });
  });
}

async function handleRpcMethod(
  method: string,
  params: Record<string, unknown>,
  options: IpcServerOptions,
): Promise<unknown> {
  switch (method) {
    case "health.ping": {
      return { ok: true, timestamp: Date.now() };
    }

    case "auth.verify_api_key": {
      const apiKeyRaw = typeof params.api_key === "string" ? params.api_key.trim() : "";
      if (!apiKeyRaw) {
        return { valid: false, error: "missing_api_key" };
      }
      const apiKey = await getApiKeyByToken(apiKeyRaw);
      if (!apiKey) {
        return { valid: false, error: "invalid_key" };
      }
      if (apiKey.revokedAt) {
        return { valid: false, error: "revoked_key" };
      }
      if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() < Date.now()) {
        return { valid: false, error: "expired_key" };
      }
      if (apiKey.quota !== null && Number(apiKey.used) >= Number(apiKey.quota)) {
        return { valid: false, error: "quota_exceeded" };
      }
      options.cacheApiKey?.(apiKey);
      return {
        valid: true,
        api_key: {
          id: apiKey.id,
          owner_user_id: apiKey.ownerUserId,
          name: apiKey.name,
          api_key: apiKey.apiKey,
          quota: apiKey.quota,
          used: apiKey.used,
        },
      };
    }

    case "auth.resolve_user_api_key": {
      const userId = typeof params.user_id === "string" ? params.user_id.trim() : "";
      if (!userId) {
        throw new Error("user_id is required");
      }
      const user = await getPortalUserById(userId);
      if (!user || !user.enabled) {
        throw new Error("User not found or disabled");
      }

      const keys = await listApiKeys({ ownerUserId: user.id });
      const existing =
        keys.find((item) => item.name === CODEX_CLIENT_API_KEY_NAME) ?? keys[0];
      if (existing) {
        options.cacheApiKey?.(existing);
        return {
          id: existing.id,
          owner_user_id: existing.ownerUserId,
          name: existing.name,
          api_key: existing.apiKey,
          quota: existing.quota,
          used: existing.used,
        };
      }

      const created = await createApiKey({
        ownerUserId: user.id,
        name: CODEX_CLIENT_API_KEY_NAME,
        apiKey: generateApiKeyValue(),
      });
      options.cacheApiKey?.(created);
      return {
        id: created.id,
        owner_user_id: created.ownerUserId,
        name: created.name,
        api_key: created.apiKey,
        quota: created.quota,
        used: created.used,
      };
    }

    case "auth.verify_portal_token": {
      const token = typeof params.token === "string" ? params.token.trim() : "";
      if (!token) {
        return { valid: false, error: "missing_token" };
      }
      try {
        const claims = verifyPortalAccessToken(token);
        if (!claims?.sub) {
          return { valid: false, error: "invalid_claims" };
        }
        const user = await getPortalUserById(claims.sub);
        if (!user || !user.enabled) {
          return { valid: false, error: "user_inactive" };
        }
        return {
          valid: true,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
          },
        };
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : "token_verification_failed",
        };
      }
    }

    case "usage.report_consumption": {
      const apiKeyId = typeof params.api_key_id === "string" ? params.api_key_id.trim() : null;
      const ownerUserId = typeof params.owner_user_id === "string" ? params.owner_user_id.trim() : null;
      const model = typeof params.model === "string" ? params.model.trim() : "codex-chatgpt";
      const totalTokens = typeof params.total_tokens === "number" ? params.total_tokens : 0;
      const promptTokens = typeof params.prompt_tokens === "number" ? params.prompt_tokens : 0;
      const completionTokens = typeof params.completion_tokens === "number" ? params.completion_tokens : 0;
      const latencyMs = typeof params.latency_ms === "number" ? params.latency_ms : null;
      const settlementId = typeof params.settlement_id === "string" ? params.settlement_id : `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const settlement: ResponseSettlement = {
        settlementId,
        intentId: null,
        ownerUserId,
        apiKeyId,
        charge: parseUsdAmount("0") ?? 0n,
        isFinal: true,
        streamEndReason: "stop",
        path: "/backend-api/codex/responses",
        modelId: model,
        serviceTier: null,
        statusCode: 200,
        ttfbMs: null,
        latencyMs,
        tokensInfo: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
        totalTokens,
        cost: null,
        errorCode: null,
        errorMessage: null,
        requestTime: new Date().toISOString(),
      };

      await flushResponseSettlements([settlement]);
      return { ok: true, settlement_id: settlementId };
    }

    default:
      throw new Error(`Method not found: ${method}`);
  }
}
