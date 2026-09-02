import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { getOpenAIAccountByEmail } from "../../../database/index.ts";
import * as openaiApiModule from "../../../openai-api/index.ts";
import type { extractCodexResultFromSse } from "../../openai-response-utils.ts";
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
> & {
  getOpenAIAccountByEmail: typeof getOpenAIAccountByEmail;
  extractCodexResultFromSse: typeof extractCodexResultFromSse;
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
            accountId: account.id,
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
        deps.invalidateActiveSourceAccount();
      }
    },
  );

  app.post(
    "/api/openai-accounts/:email/test",
    async (req: Request, res: Response) => {
      const startedAt = Date.now();
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
        const body = (req.body ?? {}) as Record<string, unknown>;
        const model =
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "gpt-5.6-luna";
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
          prompt_cache_key: crypto.randomUUID(),
        };
        const upstream = await deps.postCodexResponsesWithTokenRefresh({
          module: openaiApiModule,
          account,
          payload,
          runtimeConfig,
        });
        const responseText = await upstream.text();

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
        deps.invalidateActiveSourceAccount();
      }
    },
  );
}
