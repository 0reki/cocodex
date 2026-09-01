export function loadModelPricingFromEnv(): Array<Record<string, unknown>> {
  const raw = process.env.OPENAI_MODEL_PRICING_JSON?.trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("OPENAI_MODEL_PRICING_JSON must be a JSON array");
  }
  return parsed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
  );
}
