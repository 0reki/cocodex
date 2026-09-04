import { divideUsdAmount } from "../../../shared/usd.ts";

export const FAST_SERVICE_TIER = "fast" as const;
export const PRIORITY_SERVICE_TIER = "priority" as const;
export type FastServiceTier =
  | typeof FAST_SERVICE_TIER
  | typeof PRIORITY_SERVICE_TIER;

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
  if (
    serviceTier !== FAST_SERVICE_TIER &&
    serviceTier !== PRIORITY_SERVICE_TIER
  ) {
    return cost;
  }
  const ratio = getFastBillingRatio(modelId);
  return divideUsdAmount(cost * ratio.numerator, ratio.denominator);
}

export function resolveFastServiceTierForBilling(
  value: unknown,
): FastServiceTier | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === FAST_SERVICE_TIER ||
    normalized === PRIORITY_SERVICE_TIER
    ? normalized
    : null;
}
