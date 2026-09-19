import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import {
  createApiKey,
  getActiveOpenAIAccountByPlatform,
  getApiKeyByToken,
  getApiKeyById,
  getPortalUserById,
  listApiKeys,
  storeCodexClientRefreshToken,
  consumeCodexClientRefreshToken,
  revokeCodexClientRefreshTokens,
  type ApiKeyRecord,
  type PortalUserRecord,
} from "../../database/index.ts";
import { getCodexUserAgentForPlatform } from "../../openai-api/internal/client-identity.ts";
import { verifyPortalAccessToken } from "../auth/portal-auth.ts";
import { generateApiKeyValue } from "../utils/runtime/env-utils.ts";
import type { EnqueueResponseSettlementInput } from "../services/openai/response-settlement-services.ts";
import {
  flushResponseSettlements,
  type ResponseSettlement,
} from "../../database/internal/response-settlements.ts";
import { formatUsdAmount } from "../../shared/usd.ts";
import { createModelServices } from "../services/openai/model-services.ts";
import { loadModelPricingFromEnv } from "../utils/openai/model-pricing.ts";
import { classifyCodexBackendForward } from "../utils/openai/codex-backend-alias.ts";

const CODEX_CLIENT_API_KEY_NAME = "Codex client";
const modelServices = createModelServices({
  modelPricing: loadModelPricingFromEnv(),
});

export type IpcServerOptions = {
  socketPath?: string;
  invalidateCachedOwner?: (ownerUserId: string) => void;
  enqueueSettlement?: (
    input: EnqueueResponseSettlementInput,
  ) => Promise<void>;
};

export type IpcServerInstance = {
  socketPath: string;
  close: () => Promise<void>;
  invalidateAuth: (ownerUserId?: string) => void;
  invalidateUpstream: (platform?: string) => void;
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

export function startNodeIpcServer(
  options: IpcServerOptions = {},
): Promise<IpcServerInstance> {
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
      console.warn(
        `[ipc-server] Failed to remove existing socket at ${socketPath}:`,
        e,
      );
    }
  }

  return new Promise((resolve, reject) => {
    const clients = new Set<net.Socket>();
    const broadcastAuthInvalidate = (ownerUserId = "") => {
      const line = `${JSON.stringify({
        method: "auth.invalidate",
        params: { owner_user_id: ownerUserId },
      })}\n`;
      for (const client of clients) {
        if (client.destroyed) continue;
        client.write(line);
      }
    };
    const broadcastUpstreamInvalidate = (platform = "") => {
      const line = `${JSON.stringify({
        method: "upstream.invalidate",
        params: { platform },
      })}\n`;
      for (const client of clients) {
        if (client.destroyed) continue;
        client.write(line);
      }
    };

    const server = net.createServer((socket) => {
      clients.add(socket);
      socket.on("close", () => {
        clients.delete(socket);
      });
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
          const result = await handleRpcMethod(
            request.method,
            request.params ?? {},
            options,
          );
          // If request had an id, send response
          if (reqId !== null && reqId !== undefined) {
            const resp: JsonRpcResponse = { id: reqId, result, error: null };
            socket.write(`${JSON.stringify(resp)}\n`);
          }
        } catch (error) {
          if (reqId !== null && reqId !== undefined) {
            const message =
              error instanceof Error ? error.message : String(error);
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
      console.log(
        `[ipc-server] listening on Unix domain socket: ${socketPath}`,
      );
      resolve({
        socketPath,
        invalidateAuth: broadcastAuthInvalidate,
        invalidateUpstream: broadcastUpstreamInvalidate,
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
      const apiKeyId =
        typeof params.api_key_id === "string" ? params.api_key_id.trim() : "";
      const apiKeyRaw =
        typeof params.api_key === "string" ? params.api_key.trim() : "";
      const ownerUserId =
        typeof params.owner_user_id === "string"
          ? params.owner_user_id.trim()
          : "";
      if (ownerUserId) {
        const owner = await getPortalUserById(ownerUserId);
        if (!owner) {
          return { valid: false, error: "invalid_user" };
        }
        if (!owner.enabled) {
          return {
            valid: false,
            error: "user_inactive",
            user: toIpcUser(owner),
          };
        }
        if (
          owner.quota !== null &&
          Number(owner.used) >= Number(owner.quota)
        ) {
          return {
            valid: false,
            error: "quota_exceeded",
            user: toIpcUser(owner),
          };
        }
        return { valid: true, user: toIpcUser(owner) };
      }
      if (!apiKeyId && !apiKeyRaw) {
        return { valid: false, error: "missing_api_key" };
      }
      let apiKey: ApiKeyRecord | null = null;
      try {
        apiKey = apiKeyId
          ? await getApiKeyById(apiKeyId)
          : await getApiKeyByToken(apiKeyRaw);
      } catch {
        return { valid: false, error: "invalid_key" };
      }
      if (!apiKey) {
        return { valid: false, error: "invalid_key" };
      }
      if (apiKey.revokedAt) {
        return {
          valid: false,
          error: "revoked_key",
          api_key: toIpcApiKey(apiKey),
        };
      }
      if (
        apiKey.expiresAt &&
        new Date(apiKey.expiresAt).getTime() < Date.now()
      ) {
        return {
          valid: false,
          error: "expired_key",
          api_key: toIpcApiKey(apiKey),
        };
      }
      if (apiKey.ownerUserId) {
        const owner = await getPortalUserById(apiKey.ownerUserId);
        if (!owner || !owner.enabled) {
          return {
            valid: false,
            error: "user_inactive",
            api_key: toIpcApiKey(apiKey),
          };
        }
      }
      if (
        apiKey.quota !== null &&
        Number(apiKey.used) >= Number(apiKey.quota)
      ) {
        return {
          valid: false,
          error: "quota_exceeded",
          api_key: toIpcApiKey(apiKey),
        };
      }
      return {
        valid: true,
        api_key: toIpcApiKey(apiKey),
      };
    }

    case "auth.resolve_user_api_key": {
      const userId =
        typeof params.user_id === "string" ? params.user_id.trim() : "";
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
          user: toIpcUser(user),
        };
      } catch (err) {
        return {
          valid: false,
          error:
            err instanceof Error ? err.message : "token_verification_failed",
        };
      }
    }

    case "auth.store_refresh_token": {
      const tokenHash =
        typeof params.token_hash === "string" ? params.token_hash.trim() : "";
      const ownerUserId =
        typeof params.owner_user_id === "string"
          ? params.owner_user_id.trim()
          : "";
      const email = typeof params.email === "string" ? params.email.trim() : "";
      const expiresAtSecs =
        typeof params.expires_at_secs === "number"
          ? params.expires_at_secs
          : Number(params.expires_at_secs);
      if (!tokenHash || !ownerUserId || !email || !expiresAtSecs) {
        throw new Error("refresh token fields are required");
      }
      await storeCodexClientRefreshToken({
        tokenHash,
        ownerUserId,
        email,
        expiresAt: new Date(expiresAtSecs * 1000),
      });
      return { ok: true };
    }

    case "auth.consume_refresh_token": {
      const tokenHash =
        typeof params.token_hash === "string" ? params.token_hash.trim() : "";
      if (!tokenHash) return { found: false };
      const record = await consumeCodexClientRefreshToken(tokenHash);
      if (!record) return { found: false };
      return {
        found: true,
        email: record.email,
        owner_user_id: record.ownerUserId,
      };
    }

    case "auth.revoke_refresh_token": {
      const tokenHash =
        typeof params.token_hash === "string" ? params.token_hash.trim() : "";
      const ownerUserId =
        typeof params.owner_user_id === "string"
          ? params.owner_user_id.trim()
          : "";
      await revokeCodexClientRefreshTokens({
        tokenHash: tokenHash || null,
        ownerUserId: ownerUserId || null,
      });
      return { ok: true };
    }

    case "usage.report_consumption": {
      const apiKeyId =
        typeof params.api_key_id === "string" ? params.api_key_id.trim() : null;
      const ownerUserId =
        typeof params.owner_user_id === "string"
          ? params.owner_user_id.trim()
          : null;
      const model =
        typeof params.model === "string"
          ? params.model.trim()
          : "codex-chatgpt";
      const totalTokens =
        typeof params.total_tokens === "number" ? params.total_tokens : 0;
      const promptTokens =
        typeof params.prompt_tokens === "number" ? params.prompt_tokens : 0;
      const completionTokens =
        typeof params.completion_tokens === "number"
          ? params.completion_tokens
          : 0;
      const latencyMs =
        typeof params.latency_ms === "number" ? params.latency_ms : null;
      const ttfbMs =
        typeof params.ttfb_ms === "number" ? params.ttfb_ms : null;
      const path =
        typeof params.path === "string" && params.path.trim()
          ? params.path.trim()
          : "/backend-api/codex/responses";
      const statusCode =
        typeof params.status_code === "number" ? params.status_code : 200;
      const errorCode =
        typeof params.error_code === "string" ? params.error_code : null;
      const errorMessage =
        typeof params.error_message === "string" ? params.error_message : null;
      const isFinal =
        typeof params.is_final === "boolean" ? params.is_final : true;
      const streamEndReason =
        typeof params.stream_end_reason === "string"
          ? params.stream_end_reason
          : "stop";
      const settlementId =
        typeof params.settlement_id === "string"
          ? params.settlement_id
          : `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const tokensInfo =
        params.tokens_info &&
        typeof params.tokens_info === "object" &&
        !Array.isArray(params.tokens_info)
          ? (params.tokens_info as Record<string, unknown>)
          : {
              input_tokens: promptTokens,
              output_tokens: completionTokens,
              total_tokens: totalTokens,
            };
      const kind = classifyCodexBackendForward(path);
      const billable =
        typeof params.billable === "boolean"
          ? params.billable
          : kind === "responses";
      const estimatedCost = billable
        ? modelServices.estimateUsageCost(model, tokensInfo)
        : null;
      const cost = estimatedCost;
      const charge = billable ? (estimatedCost ?? 0n) : 0n;

      const settlement: ResponseSettlement = {
        settlementId,
        intentId: null,
        ownerUserId,
        apiKeyId,
        charge,
        isFinal,
        streamEndReason,
        path,
        modelId: model,
        serviceTier: null,
        statusCode,
        ttfbMs,
        latencyMs,
        tokensInfo,
        totalTokens,
        cost,
        errorCode,
        errorMessage,
        requestTime: new Date().toISOString(),
      };

      if (options.enqueueSettlement) {
        await options.enqueueSettlement({
          settlementId: settlement.settlementId,
          ownerUserId: settlement.ownerUserId,
          apiKeyId: settlement.apiKeyId,
          charge: settlement.charge,
          isFinal: settlement.isFinal,
          streamEndReason: settlement.streamEndReason,
          path: settlement.path,
          modelId: settlement.modelId,
          serviceTier: settlement.serviceTier,
          statusCode: settlement.statusCode,
          ttfbMs: settlement.ttfbMs,
          latencyMs: settlement.latencyMs,
          tokensInfo: settlement.tokensInfo,
          totalTokens: settlement.totalTokens,
          cost: settlement.cost,
          errorCode: settlement.errorCode,
          errorMessage: settlement.errorMessage,
          requestTime: settlement.requestTime,
        });
      } else {
        await flushResponseSettlements([settlement]);
      }
      return { ok: true, settlement_id: settlementId, cost: cost === null ? null : formatUsdAmount(cost) };
    }

    case "upstream.resolve_account": {
      const platform =
        typeof params.platform === "string" ? params.platform.trim() : "";
      if (!platform) {
        throw new Error("platform is required");
      }
      const account = await getActiveOpenAIAccountByPlatform(platform);
      if (!account) {
        throw new Error(
          `No active upstream account configured for platform: ${platform}`,
        );
      }
      return {
        account_id: account.accountId,
        access_token: account.accessToken,
        platform: account.platform,
        user_agent: getCodexUserAgentForPlatform(account.platform),
      };
    }

    default:
      throw new Error(`Method not found: ${method}`);
  }
}

function toIpcApiKey(apiKey: ApiKeyRecord) {
  return {
    id: apiKey.id,
    owner_user_id: apiKey.ownerUserId,
    name: apiKey.name,
    api_key: apiKey.apiKey,
    quota: apiKey.quota,
    used: apiKey.used,
  };
}

function toIpcUser(user: PortalUserRecord) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    enabled: user.enabled,
    quota: user.quota,
    used: user.used,
  };
}
