import type { Express, Request, Response } from "express";
import type { ensureDatabaseSchema } from "../../../database/index.ts";
import * as openaiApiModule from "../../../openai-api/index.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import {
  getReadyActiveSourceAccount,
  type ActiveSourceAccountDependencies,
} from "../../services/openai/openai-route-services.ts";

type PublicOpenAIRouteDependencies = ActiveSourceAccountDependencies &
  Pick<
    ServerServices,
    | "authenticateApiKeyWithReason"
    | "getApiKeyAuthErrorDetail"
    | "getOpenAIApiRuntimeConfig"
    | "getCodexModelsWithTokenRefresh"
    | "buildOpenAIModelsList"
    | "extractErrorInfo"
    | "buildPassthroughUpstreamError"
  > & {
    ensureDatabaseSchema: typeof ensureDatabaseSchema;
  };

export function registerPublicOpenAIRoutes(
  app: Express,
  deps: PublicOpenAIRouteDependencies,
) {
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await deps.ensureDatabaseSchema();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/v1/models", async (req: Request, res: Response) => {
    try {
      const { apiKey, reason } = await deps.authenticateApiKeyWithReason(req);
      if (!apiKey) {
        const authError = deps.getApiKeyAuthErrorDetail(reason);
        res.status(401).json({
          error: {
            message: authError.message,
            type: "invalid_request_error",
            code: authError.code,
          },
        });
        return;
      }

      const activeAccount = await getReadyActiveSourceAccount({ deps });
      if (!activeAccount.ok) {
        res.status(503).json({
          error: {
            message: "No active upstream account",
            type: "server_error",
            code: "upstream_account_unavailable",
          },
        });
        return;
      }

      const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
      const upstream = await deps.getCodexModelsWithTokenRefresh({
        module: openaiApiModule,
        account: activeAccount.sourceAccount,
        runtimeConfig,
      });
      res.json({
        object: "list",
        data: deps.buildOpenAIModelsList(
          Array.isArray(upstream.models) ? upstream.models : [],
        ),
      });
    } catch (error) {
      const errorInfo = deps.extractErrorInfo(error);
      const passthrough = deps.buildPassthroughUpstreamError({
        status: errorInfo.status,
        errorPayload: errorInfo.errorPayload,
        fallbackCode: "models_list_failed",
        fallbackMessage: errorInfo.message ?? "Failed to list models",
      });
      res.status(passthrough.status).json({
        error: passthrough.error,
      });
    }
  });
}
