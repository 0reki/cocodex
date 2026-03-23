import type { Request, Response } from "express";

export function createRequestLimitServices(deps: {
  normalizeUserRpmLimit: (value: unknown) => number;
  normalizeUserMaxInFlight: (value: unknown) => number;
  requestRateLimitConfig: {
    userRpmLimit: number;
    userMaxInFlight: number;
  };
  userRpmCounters: Map<
    string,
    { windowStartMs: number; count: number; lastSeenMs: number }
  >;
  userRpmCounterMax: number;
  userRpmCleanupState: { tick: number };
  userInFlightCounters: Map<string, { count: number; lastSeenMs: number }>;
  userInFlightStaleMs: number;
  userInFlightCleanupState: { tick: number };
}) {
  function pruneUserRpmCounters(now: number) {
    const staleBefore = now - 5 * 60_000;
    for (const [userId, entry] of deps.userRpmCounters.entries()) {
      if (entry.lastSeenMs < staleBefore) {
        deps.userRpmCounters.delete(userId);
      }
    }

    if (deps.userRpmCounters.size <= deps.userRpmCounterMax) return;
    const overflow = deps.userRpmCounters.size - deps.userRpmCounterMax;
    if (overflow <= 0) return;

    const sorted = Array.from(deps.userRpmCounters.entries()).sort(
      (a, b) => a[1].lastSeenMs - b[1].lastSeenMs,
    );
    for (let i = 0; i < overflow; i += 1) {
      const userId = sorted[i]?.[0];
      if (!userId) break;
      deps.userRpmCounters.delete(userId);
    }
  }

  function pruneUserInFlightCounters(now: number) {
    for (const [userId, entry] of deps.userInFlightCounters.entries()) {
      const staleMs = now - entry.lastSeenMs;
      const isStale =
        entry.count <= 0 ||
        (Number.isFinite(deps.userInFlightStaleMs) &&
          deps.userInFlightStaleMs > 0 &&
          staleMs >= deps.userInFlightStaleMs);
      if (isStale) {
        if (entry.count > 0) {
          console.warn(
            `[rate-limit] cleared stale user in-flight counter user=${userId} count=${entry.count} ageMs=${Math.max(
              0,
              staleMs,
            )}`,
          );
        }
        deps.userInFlightCounters.delete(userId);
      }
    }
  }

  function touchUserInFlightSlot(ownerUserId: string | null) {
    const userId = ownerUserId?.trim() ?? "";
    if (!userId) return;
    const latest = deps.userInFlightCounters.get(userId);
    if (!latest || latest.count <= 0) return;
    latest.lastSeenMs = Date.now();
    deps.userInFlightCounters.set(userId, latest);
  }

  function consumeUserRpmAllowance(
    ownerUserId: string | null,
    limitOverride?: number | null,
  ) {
    const userId = ownerUserId?.trim() ?? "";
    const limit =
      limitOverride == null
        ? deps.requestRateLimitConfig.userRpmLimit
        : deps.normalizeUserRpmLimit(limitOverride);
    const refundNoop = () => {};
    if (!userId || limit <= 0) {
      return { allowed: true, retryAfterSec: null, refund: refundNoop };
    }

    const now = Date.now();
    const windowStartMs = Math.floor(now / 60_000) * 60_000;
    const existing = deps.userRpmCounters.get(userId);
    const counter =
      existing && existing.windowStartMs === windowStartMs
        ? existing
        : { windowStartMs, count: 0, lastSeenMs: now };

    if (counter.count >= limit) {
      counter.lastSeenMs = now;
      deps.userRpmCounters.set(userId, counter);
      return {
        allowed: false,
        retryAfterSec: Math.max(
          1,
          Math.ceil((windowStartMs + 60_000 - now) / 1000),
        ),
        refund: refundNoop,
      };
    }

    counter.count += 1;
    counter.lastSeenMs = now;
    deps.userRpmCounters.set(userId, counter);
    deps.userRpmCleanupState.tick += 1;
    if ((deps.userRpmCleanupState.tick & 0x1ff) === 0) {
      pruneUserRpmCounters(now);
    }
    let refunded = false;
    const refund = () => {
      if (refunded) return;
      refunded = true;
      const latest = deps.userRpmCounters.get(userId);
      if (!latest) return;
      if (latest.windowStartMs !== windowStartMs) return;
      latest.count = Math.max(0, latest.count - 1);
      latest.lastSeenMs = Date.now();
      if (latest.count <= 0) {
        deps.userRpmCounters.delete(userId);
        return;
      }
      deps.userRpmCounters.set(userId, latest);
    };

    return { allowed: true, retryAfterSec: null, refund };
  }

  function acquireUserInFlightSlot(
    ownerUserId: string | null,
    limitOverride?: number | null,
  ) {
    const userId = ownerUserId?.trim() ?? "";
    const limit =
      limitOverride == null
        ? deps.requestRateLimitConfig.userMaxInFlight
        : deps.normalizeUserMaxInFlight(limitOverride);
    const releaseNoop = () => {};
    if (!userId || limit <= 0) {
      return { allowed: true, retryAfterSec: null, release: releaseNoop };
    }

    const now = Date.now();
    const existing = deps.userInFlightCounters.get(userId);
    const staleExisting =
      existing &&
      Number.isFinite(deps.userInFlightStaleMs) &&
      deps.userInFlightStaleMs > 0 &&
      now - existing.lastSeenMs >= deps.userInFlightStaleMs;
    if (existing && staleExisting) {
      console.warn(
        `[rate-limit] reset stale user in-flight counter user=${userId} count=${existing.count} ageMs=${Math.max(
          0,
          now - existing.lastSeenMs,
        )}`,
      );
      deps.userInFlightCounters.delete(userId);
    }
    const counter =
      existing && !staleExisting ? existing : { count: 0, lastSeenMs: now };
    if (counter.count >= limit) {
      return {
        allowed: false,
        retryAfterSec: 1,
        release: releaseNoop,
      };
    }

    counter.count += 1;
    counter.lastSeenMs = now;
    deps.userInFlightCounters.set(userId, counter);
    deps.userInFlightCleanupState.tick += 1;
    if ((deps.userInFlightCleanupState.tick & 0x1ff) === 0) {
      pruneUserInFlightCounters(now);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const latest = deps.userInFlightCounters.get(userId);
      if (!latest) return;
      latest.count = Math.max(0, latest.count - 1);
      latest.lastSeenMs = Date.now();
      if (latest.count <= 0) {
        deps.userInFlightCounters.delete(userId);
        return;
      }
      deps.userInFlightCounters.set(userId, latest);
    };

    return {
      allowed: true,
      retryAfterSec: null,
      release,
    };
  }

  function createRequestAbortContext(req: Request, res: Response) {
    const controller = new AbortController();
    let aborted = false;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      controller.abort();
    };
    const onReqAborted = () => abort();
    const onResClose = () => {
      if (!res.writableEnded) {
        abort();
      }
    };
    req.on("aborted", onReqAborted);
    res.on("close", onResClose);
    return {
      signal: controller.signal,
      cleanup: () => {
        req.off("aborted", onReqAborted);
        res.off("close", onResClose);
      },
    };
  }

  return {
    touchUserInFlightSlot,
    consumeUserRpmAllowance,
    acquireUserInFlightSlot,
    createRequestAbortContext,
  };
}
