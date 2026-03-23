export type OpenAIModel = {
  slug?: string;
  display_name?: string;
  input_price_per_million?: number | null;
  cached_input_price_per_million?: number | null;
  output_price_per_million?: number | null;
  input_price_per_million_after_400k_tokens?: number | null;
  cached_input_price_per_million_after_400k_tokens?: number | null;
  output_price_per_million_after_400k_tokens?: number | null;
  double_price_after_400k_tokens?: boolean | null;
  enabled?: boolean | null;
};

export type SystemSettingsResponse = {
  openaiApiUserAgent: string | null;
  openaiClientVersion: string | null;
  inboxTranslationModel: string | null;
  cloudMailDomains: string[];
  accountSubmissionAddonDailyQuota: number | null;
  accountSubmissionAddonWeeklyCap: number | null;
  accountSubmissionAddonMonthlyCap: number | null;
  accountCacheSize: number | null;
  accountCacheRefreshSeconds: number | null;
  maxAttemptCount: number | null;
  userRpmLimit: number | null;
  userMaxInFlight: number | null;
  effectiveAccountCacheSize?: number;
  effectiveAccountCacheRefreshSeconds?: number;
  effectiveMaxAttemptCount?: number;
  effectiveUserRpmLimit?: number;
  effectiveUserMaxInFlight?: number;
  openaiModels?: OpenAIModel[];
  openaiModelsUpdatedAt?: string | null;
  effectiveOpenAIApiUserAgent: string;
  effectiveOpenAIClientVersion: string;
  updatedAt: string | null;
};

export type OpenAIModelPriceKey =
  | "input_price_per_million"
  | "cached_input_price_per_million"
  | "output_price_per_million"
  | "input_price_per_million_after_400k_tokens"
  | "cached_input_price_per_million_after_400k_tokens"
  | "output_price_per_million_after_400k_tokens";
