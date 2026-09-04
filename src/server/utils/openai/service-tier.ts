import { divideUsdAmount } from "../../../shared/usd.ts";

export const PRIORITY_SERVICE_TIER = "priority" as const;
export type FastServiceTier = typeof PRIORITY_SERVICE_TIER;
export type ServiceTierBillingResolution = {
  serviceTier: string | null;
  fastServiceTier: FastServiceTier | null;
};

function normalizeServiceTier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function getFastBillingRatio(modelId: string | null | undefined) {
  const normalizedModelId = modelId
    ?.trim()
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (
    normalizedModelId === "gpt-6-astra" ||
    normalizedModelId === "gpt-5.5" ||
    normalizedModelId === "gpt-5.6" ||
    normalizedModelId?.startsWith("gpt-5.6-")
  ) {
    return { numerator: 5n, denominator: 2n };
  }
  if (normalizedModelId === "gpt-5.4") {
    return { numerator: 2n, denominator: 1n };
  }
  return { numerator: 1n, denominator: 1n };
}

export function applyServiceTierBillingMultiplier(
  cost: bigint | null,
  serviceTier: FastServiceTier | null | undefined,
  modelId: string | null,
): bigint | null {
  if (cost === null) return null;
  if (serviceTier !== PRIORITY_SERVICE_TIER) {
    return cost;
  }
  const ratio = getFastBillingRatio(modelId);
  return divideUsdAmount(cost * ratio.numerator, ratio.denominator);
}

export function resolveFastServiceTierForBilling(
  value: unknown,
): FastServiceTier | null {
  const normalized = normalizeServiceTier(value);
  return normalized === PRIORITY_SERVICE_TIER ? normalized : null;
}

export function resolveResponseServiceTierForBilling(
  responseValue: unknown,
  requestedValue: unknown,
): ServiceTierBillingResolution {
  const serviceTier =
    normalizeServiceTier(responseValue) ?? normalizeServiceTier(requestedValue);
  return {
    serviceTier,
    fastServiceTier: resolveFastServiceTierForBilling(serviceTier),
  };
}
