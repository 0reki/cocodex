export const PRIORITY_SERVICE_TIER = "priority" as const;
export const PRIORITY_SERVICE_TIER_BILLING_MULTIPLIER = 2;

export function applyServiceTierBillingMultiplier(
  cost: number | null,
  serviceTier: typeof PRIORITY_SERVICE_TIER | null | undefined,
): number | null {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return null;
  const multiplier =
    serviceTier === PRIORITY_SERVICE_TIER
      ? PRIORITY_SERVICE_TIER_BILLING_MULTIPLIER
      : 1;
  return Number((cost * multiplier).toFixed(8));
}

export function resolvePriorityServiceTierForBilling(
  value: unknown,
): typeof PRIORITY_SERVICE_TIER | null {
  return typeof value === "string" &&
    value.trim().toLowerCase() === PRIORITY_SERVICE_TIER
    ? PRIORITY_SERVICE_TIER
    : null;
}
