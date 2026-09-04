import { divideUsdAmount } from "../../../shared/usd.ts";

export const PRIORITY_SERVICE_TIER = "priority" as const;

function getPriorityBillingRatio(modelId: string | null | undefined) {
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
  serviceTier: typeof PRIORITY_SERVICE_TIER | null | undefined,
  modelId: string | null,
): bigint | null {
  if (cost === null) return null;
  if (serviceTier !== PRIORITY_SERVICE_TIER) return cost;
  const ratio = getPriorityBillingRatio(modelId);
  return divideUsdAmount(cost * ratio.numerator, ratio.denominator);
}

export function resolvePriorityServiceTierForBilling(
  value: unknown,
): typeof PRIORITY_SERVICE_TIER | null {
  return typeof value === "string" &&
    value.trim().toLowerCase() === PRIORITY_SERVICE_TIER
    ? PRIORITY_SERVICE_TIER
    : null;
}
