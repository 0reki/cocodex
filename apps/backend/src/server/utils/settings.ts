export const OPENAI_MODELS_STORAGE_KEYS = new Set([
  "slug",
  "display_name",
  "description",
  "context_window",
  "input_modalities",
  "support_verbosity",
  "default_verbosity",
  "supports_parallel_tool_calls",
  "supports_reasoning_summaries",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "truncation_policy",
  "available_in_plans",
  "input_price_per_million",
  "cached_input_price_per_million",
  "output_price_per_million",
  "input_price_per_million_after_400k_tokens",
  "cached_input_price_per_million_after_400k_tokens",
  "output_price_per_million_after_400k_tokens",
  "double_price_after_400k_tokens",
  "enabled",
]);

export function sanitizeOpenAIModelsForStorage(
  models: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return models.map((model) => {
    const sanitized: Record<string, unknown> = {};
    for (const key of OPENAI_MODELS_STORAGE_KEYS) {
      if (key in model) {
        sanitized[key] = model[key];
      }
    }
    return sanitized;
  });
}

export function isOpenAIModelEnabled(model: Record<string, unknown> | null): boolean {
  if (!model) return false;
  return model.enabled !== false;
}

export function normalizeAccountCacheSize(value: unknown, fallback = 50) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

export function normalizeAccountCacheRefreshSeconds(
  value: unknown,
  fallback = 60,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(3600, Math.floor(parsed)));
}

export function normalizeCloudMailDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    for (const piece of item.split(/[\s,]+/)) {
      const normalized = piece.trim().toLowerCase().replace(/^@+/, "");
      if (!normalized) continue;
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) continue;
      seen.add(normalized);
    }
  }
  return [...seen];
}

export function normalizeOwnerMailDomains(value: unknown): string[] {
  return normalizeCloudMailDomains(value);
}

export function normalizeMaxAttemptCount(value: unknown, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

export function normalizeUserRpmLimit(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100_000, Math.floor(parsed)));
}

export function normalizeUserMaxInFlight(
  value: unknown,
  defaultValue = 0,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Number.isFinite(defaultValue)
      ? Math.max(0, Math.min(1_000, Math.floor(defaultValue)))
      : 0;
  }
  return Math.max(0, Math.min(1_000, Math.floor(parsed)));
}

export function normalizeCheckInReward(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1_000_000, parsed));
}
