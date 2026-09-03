import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { getOpenAIAccountByEmail } from "../../../database/index.ts";
import * as openaiApiModule from "../../../openai-api/index.ts";
import type {
  extractCodexResultFromSse,
  extractCodexTerminalResponseFromSse,
} from "../../openai-response-utils.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import {
  createAccountUsageSummaryService,
  resolveUsageAnalyticsDateRange,
} from "../../services/openai/account-usage-services.ts";

type AccountMaintenanceRouteDependencies = Pick<
  ServerServices,
  | "getOpenAIApiRuntimeConfig"
  | "getCodexDailyWorkspaceUsageWithTokenRefresh"
  | "getCodexUsageWithTokenRefresh"
  | "postCodexResponsesWithTokenRefresh"
  | "invalidateActiveSourceAccount"
  | "getPortalPrincipalFromLocals"
  | "ensureUserUpstreamQuota"
  | "settleUserUpstreamQuota"
  | "extractResponseUsage"
  | "estimateUsageCost"
> & {
  getOpenAIAccountByEmail: typeof getOpenAIAccountByEmail;
  extractCodexResultFromSse: typeof extractCodexResultFromSse;
  extractCodexTerminalResponseFromSse: typeof extractCodexTerminalResponseFromSse;
};

export function registerAccountMaintenanceRoutes(
  app: Express,
  deps: AccountMaintenanceRouteDependencies,
) {
  const usageSummaryService = createAccountUsageSummaryService();

  app.get(
    "/api/openai-accounts/:email/usage",
    async (req: Request, res: Response) => {
      try {
        const email = decodeURIComponent(String(req.params.email ?? "")).trim();
        if (!email) {
          res.status(400).json({ ok: false, error: "email is required" });
          return;
        }
        const account = await deps.getOpenAIAccountByEmail(email);
        if (!account?.accessToken) {
          res.status(404).json({ ok: false, error: "Account not found" });
          return;
        }

        const capturedAtMs = Date.now();
        const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
        const signal = AbortSignal.timeout(25_000);
        const usage = await deps.getCodexUsageWithTokenRefresh({
          module: openaiApiModule,
          account,
          runtimeConfig,
          signal,
        });
        const range = resolveUsageAnalyticsDateRange(usage, capturedAtMs);
        const dailyUsage =
          await deps.getCodexDailyWorkspaceUsageWithTokenRefresh({
            module: openaiApiModule,
            account,
            runtimeConfig,
            startDate: range.startDate,
            endDate: range.endDate,
            signal,
          });

        res.json({
          ok: true,
          ...usageSummaryService.summarize({
            usage,
            dailyUsage,
            capturedAtMs,
          }),
        });
      } catch (error) {
        res.status(502).json({
          ok: false,
          error: "Failed to fetch upstream usage",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await deps.invalidateActiveSourceAccount();
      }
    },
  );

  app.post(
    "/api/openai-accounts/:email/test",
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
      const settlementId = crypto.randomUUID();
      const ownerUserId = deps.getPortalPrincipalFromLocals(res)?.id ?? null;
      let sourceAccount: Awaited<
        ReturnType<typeof getOpenAIAccountByEmail>
      > = null;
      let model: string | null = null;
      let cost: ReturnType<ServerServices["estimateUsageCost"]> = null;
      let totalTokens: number | null = null;
      let upstreamRequestStarted = false;
      try {
        const email = decodeURIComponent(String(req.params.email ?? "")).trim();
        if (!email) {
          res.status(400).json({ ok: false, error: "email is required" });
          return;
        }
        const account = await deps.getOpenAIAccountByEmail(email);
        if (!account?.accessToken) {
          res.status(404).json({ ok: false, error: "Account not found" });
          return;
        }
        sourceAccount = account;
        if (!ownerUserId) {
          res.status(401).json({ ok: false, error: "Unauthorized" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        model =
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "gpt-5.6-luna";
        const quota = await deps.ensureUserUpstreamQuota({
          sourceAccount: account,
          ownerUserId,
          model,
        });
        if (!quota.allowed) {
          res.status(429).json({
            ok: false,
            error: "upstream_user_quota_exceeded",
          });
          return;
        }
        const text =
          typeof body.text === "string" && body.text.trim()
            ? body.text.trim()
            : "test";
        const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
        const payload = {
          model,
          instructions: "",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          ],
          tools: [],
          store: false,
          stream: true,
          prompt_cache_key: settlementId,
        };
        upstreamRequestStarted = true;
        const upstream = await deps.postCodexResponsesWithTokenRefresh({
          module: openaiApiModule,
          account,
          payload,
          runtimeConfig,
        });
        const responseText = await upstream.text();
        const terminalResponse =
          deps.extractCodexTerminalResponseFromSse(responseText);
        const usage = deps.extractResponseUsage(
          terminalResponse ? { response: terminalResponse } : null,
        );
        cost = deps.estimateUsageCost(model, usage.tokensInfo);
        totalTokens = usage.totalTokens;

        res.status(upstream.status).json({
          ok: upstream.ok,
          durationMs: Date.now() - startedAt,
          upstreamStatus: upstream.status,
          result: deps.extractCodexResultFromSse(responseText),
        });
      } catch (error) {
        res.status(500).json({
          ok: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (upstreamRequestStarted && sourceAccount && ownerUserId) {
          try {
            await deps.settleUserUpstreamQuota({
              settlementId,
              sourceAccount,
              ownerUserId,
              model,
              cost,
              totalTokens,
            });
          } catch (error) {
            console.warn(
              `[quota] failed to settle account test usage: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        await deps.invalidateActiveSourceAccount();
      }
    },
  );
}
