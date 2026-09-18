import type { Express, Request, Response } from "express";
import type { ensureDatabaseSchema } from "../../../database/index.ts";
import type { ServerServices } from "../../bootstrap/services.ts";

type PublicOpenAIRouteDependencies = Pick<
  ServerServices,
  "getResponseSettlementQueueHealth"
> & {
  ensureDatabaseSchema: typeof ensureDatabaseSchema;
};

export function registerPublicOpenAIRoutes(
  app: Express,
  deps: PublicOpenAIRouteDependencies,
) {
  app.get("/health", async (_req: Request, res: Response) => {
    if (!process.env.DATABASE_URL?.trim()) {
      res.json({ ok: true, ready: false, setupRequired: true });
      return;
    }
    try {
      await deps.ensureDatabaseSchema();
      const settlement = deps.getResponseSettlementQueueHealth();
      res.status(settlement.acceptingRequests ? 200 : 503).json({
        ok: settlement.acceptingRequests,
        settlement,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
