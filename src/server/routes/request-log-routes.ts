import type { Express, Request, Response } from "express";

import {
  InvalidModelResponseLogCursorError,
  type getModelHourlyStatsSeries,
  type getPortalUserModelHourlyStatsSeries,
  type getRequestRateStats,
  type listModelResponseLogsCursor,
  type listModelResponseLogsCursorByOwnerUserId,
} from "../../database/index.ts";
import type { ServerServices } from "../bootstrap/services.ts";

type RequestLogRouteDependencies = Pick<
  ServerServices,
  "getPortalPrincipalFromLocals"
> & {
  listModelResponseLogsCursor: typeof listModelResponseLogsCursor;
  listModelResponseLogsCursorByOwnerUserId: typeof listModelResponseLogsCursorByOwnerUserId;
  getModelHourlyStatsSeries: typeof getModelHourlyStatsSeries;
  getPortalUserModelHourlyStatsSeries: typeof getPortalUserModelHourlyStatsSeries;
  getRequestRateStats: typeof getRequestRateStats;
};

const REQUEST_STATUSES = new Set([
  "success",
  "failed",
  "aborted",
  "incomplete",
]);

function queryString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(maximum, Math.floor(parsed)))
    : fallback;
}

function sendLogQueryError(res: Response, error: unknown) {
  res.status(500).json({
    error: "Failed to query request logs",
    detail: error instanceof Error ? error.message : String(error),
  });
}

export function registerRequestLogRoutes(
  app: Express,
  deps: RequestLogRouteDependencies,
) {
  app.get("/api/request-logs", async (req: Request, res: Response) => {
    const principal = deps.getPortalPrincipalFromLocals(res);
    if (!principal) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const requestStatus =
      queryString(req.query.status) || queryString(req.query.requestStatus);
    if (requestStatus && !REQUEST_STATUSES.has(requestStatus)) {
      res.status(400).json({ error: "status is invalid" });
      return;
    }

    const limit = boundedInteger(req.query.limit, 50, 500);
    const cursor = queryString(req.query.cursor);
    const keyId = queryString(req.query.keyId);
    const requestDate = queryString(req.query.date);
    const requestDateFrom = queryString(req.query.dateFrom);
    const requestDateTo = queryString(req.query.dateTo);
    if (keyId && !isUuid(keyId)) {
      res.status(400).json({ error: "keyId is invalid" });
      return;
    }
    if (
      (requestDate && !isDate(requestDate)) ||
      (requestDateFrom && !isDate(requestDateFrom)) ||
      (requestDateTo && !isDate(requestDateTo))
    ) {
      res.status(400).json({ error: "date filter is invalid" });
      return;
    }

    const filters = {
      keyId,
      modelId: queryString(req.query.modelId),
      requestStatus,
      requestDate,
      requestDateFrom,
      requestDateTo,
    };

    try {
      const result =
        principal.role === "admin"
          ? await deps.listModelResponseLogsCursor(limit, cursor, filters)
          : await deps.listModelResponseLogsCursorByOwnerUserId(
              principal.id,
              limit,
              cursor,
              filters,
            );
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidModelResponseLogCursorError) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendLogQueryError(res, error);
    }
  });

  app.get("/api/request-logs/hourly", async (req: Request, res: Response) => {
    const principal = deps.getPortalPrincipalFromLocals(res);
    if (!principal) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const lookbackHours = boundedInteger(
      req.query.lookbackHours,
      24 * 30,
      24 * 90,
    );
    const maxModels = boundedInteger(req.query.maxModels, 6, 12);

    try {
      const [series, rates] = await Promise.all([
        principal.role === "admin"
          ? deps.getModelHourlyStatsSeries(lookbackHours, maxModels)
          : deps.getPortalUserModelHourlyStatsSeries(
              principal.id,
              lookbackHours,
              maxModels,
            ),
        deps.getRequestRateStats(
          principal.role === "admin" ? null : principal.id,
        ),
      ]);
      res.json({ ...series, ...rates });
    } catch (error) {
      sendLogQueryError(res, error);
    }
  });
}
