import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { getActiveOpenAIAccountByPlatform } from "../../database/index.ts";
import { getCodexUserAgentForPlatform } from "../../openai-api/internal/client-identity.ts";
import type { EnqueueResponseSettlementInput } from "../services/openai/response-settlement-services.ts";
import {
  flushResponseSettlements,
  type ResponseSettlement,
} from "../../database/internal/response-settlements.ts";
import { formatUsdAmount } from "../../shared/usd.ts";
import { createModelServices } from "../services/openai/model-services.ts";
import { loadModelPricingFromEnv } from "../utils/openai/model-pricing.ts";
import { classifyCodexBackendForward } from "../utils/openai/codex-backend-alias.ts";

const modelServices = createModelServices({
  modelPricing: loadModelPricingFromEnv(),
});

export type IpcServerOptions = {
  socketPath?: string;
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



