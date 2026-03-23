export const PRIORITY_SERVICE_TIER = "priority" as const;
export const PRIORITY_SERVICE_TIER_ERROR_MESSAGE =
  "Invalid value for service_tier. Only 'priority' is supported.";
export const PRIORITY_SERVICE_TIER_BILLING_MULTIPLIER = 2;

export function buildInvalidPriorityServiceTierErrorPayload() {
  return {
    error: {
      message: PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
      type: "invalid_request_error",
      code: "invalid_request_error",
    },
  };
}

export function parsePriorityServiceTier(value: unknown): {
  value: typeof PRIORITY_SERVICE_TIER | null;
  valid: boolean;
} {
  if (value === undefined || value === null) {
    return { value: null, valid: true };
  }
  if (typeof value !== "string") {
    return { value: null, valid: false };
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return { value: null, valid: false };
  }
  if (normalized !== PRIORITY_SERVICE_TIER) {
    return { value: null, valid: false };
  }
  return { value: PRIORITY_SERVICE_TIER, valid: true };
}

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
  const result = parsePriorityServiceTier(value);
  return result.valid ? result.value : null;
}
