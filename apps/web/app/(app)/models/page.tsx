import { getBackendBaseUrl } from "@/lib/backend/backend-base-url";
import { CopyButton } from "@/components/common/copy-button";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";
import { Zap } from "lucide-react";

type SystemSettingsResponse = {
  openaiModels?: Array<Record<string, unknown>>;
  openaiModelsUpdatedAt?: string | null;
};

type ReasoningLevel = {
  effort: string;
  description: string | null;
};

type ParsedModel = {
  slug: string;
  displayName: string;
  description: string | null;
  contextWindow: number | null;
  inputModalities: string[];
  defaultVerbosity: string | null;
  supportVerbosity: boolean | null;
  truncationMode: string | null;
  truncationLimit: number | null;
  availablePlans: string[];
  defaultReasoningLevel: string | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedInputPricePerMillion: number | null;
  inputPricePerMillionAfter400kTokens: number | null;
  outputPricePerMillionAfter400kTokens: number | null;
  cachedInputPricePerMillionAfter400kTokens: number | null;
  supportsParallelToolCalls: boolean | null;
  supportsReasoningSummaries: boolean | null;
  supportedReasoningLevels: ReasoningLevel[];
  additionalFields: Array<{ key: string; value: string }>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function asReasoningLevels(value: unknown): ReasoningLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const effort = asString(record.effort);
      if (!effort) return null;
      return {
        effort,
        description: asString(record.description),
      };
    })
    .filter((item): item is ReasoningLevel => item !== null);
}

function parseModel(model: Record<string, unknown>): ParsedModel {
  const truncation =
    model.truncation_policy && typeof model.truncation_policy === "object"
      ? (model.truncation_policy as Record<string, unknown>)
      : null;

  const knownKeys = new Set<string>([
    "slug",
    "display_name",
    "description",
    "context_window",
    "input_modalities",
    "default_verbosity",
    "support_verbosity",
    "truncation_policy",
    "available_in_plans",
    "default_reasoning_level",
    "input_price_per_million",
    "output_price_per_million",
    "cached_input_price_per_million",
    "input_price_per_million_after_400k_tokens",
    "output_price_per_million_after_400k_tokens",
    "cached_input_price_per_million_after_400k_tokens",
    "double_price_after_400k_tokens",
    "enabled",
    "supports_parallel_tool_calls",
    "supports_reasoning_summaries",
    "supported_reasoning_levels",
  ]);
  const additionalFields = Object.entries(model)
    .filter(([key, value]) => !knownKeys.has(key) && value !== undefined)
    .map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? value
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value),
    }));

  return {
    slug: asString(model.slug) ?? "(unknown)",
    displayName:
      asString(model.display_name) ?? asString(model.slug) ?? "(unnamed)",
    description: asString(model.description),
    contextWindow: asNumber(model.context_window),
    inputModalities: asStringArray(model.input_modalities),
    defaultVerbosity: asString(model.default_verbosity),
    supportVerbosity: asBoolean(model.support_verbosity),
    truncationMode: truncation ? asString(truncation.mode) : null,
    truncationLimit: truncation ? asNumber(truncation.limit) : null,
    availablePlans: asStringArray(model.available_in_plans),
    defaultReasoningLevel: asString(model.default_reasoning_level),
    inputPricePerMillion: asNumber(model.input_price_per_million),
    outputPricePerMillion: asNumber(model.output_price_per_million),
    cachedInputPricePerMillion: asNumber(model.cached_input_price_per_million),
    inputPricePerMillionAfter400kTokens: asNumber(
      model.input_price_per_million_after_400k_tokens,
    ),
    outputPricePerMillionAfter400kTokens: asNumber(
      model.output_price_per_million_after_400k_tokens,
    ),
    cachedInputPricePerMillionAfter400kTokens: asNumber(
      model.cached_input_price_per_million_after_400k_tokens,
    ),
    supportsParallelToolCalls: asBoolean(model.supports_parallel_tool_calls),
    supportsReasoningSummaries: asBoolean(model.supports_reasoning_summaries),
    supportedReasoningLevels: asReasoningLevels(
      model.supported_reasoning_levels,
    ),
    additionalFields,
  };
}

function formatNumber(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("en-US");
}

function formatMoney(value: number | null): string {
  if (value === null) return "-";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

function formatBool(value: boolean | null): string {
  if (value === null) return "-";
  return value ? "Yes" : "No";
}

async function loadModels() {
  const base = getBackendBaseUrl();
  const res = await fetch(`${base}/api/public/models`, {
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend ${res.status}: ${text}`);
  }

  const data = (await res.json()) as SystemSettingsResponse;
  const openaiModels = Array.isArray(data.openaiModels)
    ? data.openaiModels
    : [];
  return {
    models: openaiModels
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object",
      )
      .map(parseModel)
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

export default async function ModelsPage() {
  await requireAuth("/models");
  const { t } = await getServerTranslator();
  try {
    const { models } = await loadModels();

    return (
      <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
        <section>
          <h1 className="text-2xl font-bold">{t("page.models")}</h1>
        </section>

        <section className="grid grid-cols-1 gap-4">
          <div className="space-y-2">
            <h2 className="text-base font-semibold">OpenAI</h2>
            <p className="text-sm text-muted-foreground">
              <span>{t("models.fastModeHintPrefix")}</span>
              <span className="whitespace-nowrap">
                {" "}
                <span
                  aria-label={t("logs.fastModeTooltip")}
                  className="mx-1 inline-flex h-4 w-4 translate-y-[0.125em] items-center justify-center rounded-sm text-emerald-500"
                >
                  <Zap
                    className="h-3.5 w-3.5 fill-current"
                    fill="currentColor"
                    strokeWidth={1.75}
                  />
                </span>
                <span>{t("models.fastModeHintSuffix")}</span>
              </span>
            </p>
          </div>
          {models.length === 0 ? (
            <div className="rounded-xl border p-8 text-center text-muted-foreground">
              No models found.
            </div>
          ) : null}

          {models.map((model) => (
            <article key={model.slug} className="rounded-xl border p-4">
              <header className="mb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{model.slug}</h2>
                  <CopyButton text={model.slug} />
                </div>
                {model.description ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {model.description}
                  </p>
                ) : null}
              </header>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <section className="rounded-lg border p-3">
                  <h3 className="mb-2 text-sm font-semibold">Core</h3>
                  <div className="space-y-1 wrap-break-word text-sm">
                    {model.contextWindow !== null ? (
                      <div>
                        Context Window: {formatNumber(model.contextWindow)}{" "}
                        Tokens
                      </div>
                    ) : null}
                    {model.inputModalities.length > 0 ? (
                      <div>
                        Input Modalities: {model.inputModalities.join(", ")}
                      </div>
                    ) : null}
                    {model.defaultVerbosity !== null ? (
                      <div>Default Verbosity: {model.defaultVerbosity}</div>
                    ) : null}
                    {model.supportVerbosity !== null ? (
                      <div>
                        Support Verbosity: {formatBool(model.supportVerbosity)}
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="rounded-lg border p-3">
                  <h3 className="mb-2 text-sm font-semibold">Pricing</h3>
                  <div className="space-y-1 wrap-break-word text-sm">
                    {model.inputPricePerMillion !== null ? (
                      <div>
                        Inputs: {formatMoney(model.inputPricePerMillion)} /M
                        Tokens
                      </div>
                    ) : null}
                    {model.outputPricePerMillion !== null ? (
                      <div>
                        Output: {formatMoney(model.outputPricePerMillion)} /M
                        Tokens
                      </div>
                    ) : null}
                    {model.cachedInputPricePerMillion !== null ? (
                      <div>
                        Cached Input:{" "}
                        {formatMoney(model.cachedInputPricePerMillion)} /M
                        Tokens
                      </div>
                    ) : null}
                    {model.inputPricePerMillionAfter400kTokens !== null ? (
                      <div>
                        Input When Input &gt;272K:{" "}
                        {formatMoney(model.inputPricePerMillionAfter400kTokens)}{" "}
                        /M Tokens
                      </div>
                    ) : null}
                    {model.cachedInputPricePerMillionAfter400kTokens !==
                    null ? (
                      <div>
                        Cached Input When Input &gt;272K:{" "}
                        {formatMoney(
                          model.cachedInputPricePerMillionAfter400kTokens,
                        )}{" "}
                        /M Tokens
                      </div>
                    ) : null}
                    {model.outputPricePerMillionAfter400kTokens !== null ? (
                      <div>
                        Output When Input &gt;272K:{" "}
                        {formatMoney(
                          model.outputPricePerMillionAfter400kTokens,
                        )}{" "}
                        /M Tokens
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="rounded-lg border p-3">
                  <h3 className="mb-2 text-sm font-semibold">Behavior</h3>
                  <div className="space-y-1 wrap-break-word text-sm">
                    {model.defaultReasoningLevel !== null ? (
                      <div>
                        Default Reasoning: {model.defaultReasoningLevel}
                      </div>
                    ) : null}
                    {model.supportsParallelToolCalls !== null ? (
                      <div>
                        Parallel Tool Calls:{" "}
                        {formatBool(model.supportsParallelToolCalls)}
                      </div>
                    ) : null}
                    {model.supportsReasoningSummaries !== null ? (
                      <div>
                        Reasoning Summaries:{" "}
                        {formatBool(model.supportsReasoningSummaries)}
                      </div>
                    ) : null}
                    {model.truncationMode !== null ||
                    model.truncationLimit !== null ? (
                      <div>
                        Truncation: {model.truncationMode ?? "-"}
                        {model.truncationLimit !== null
                          ? ` (${formatNumber(model.truncationLimit)})`
                          : ""}
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>

              {model.supportedReasoningLevels.length > 0 ? (
                <section className="mt-4 rounded-lg border p-3">
                  <h3 className="mb-2 text-sm font-semibold">
                    Supported Reasoning Levels
                  </h3>
                  <div className="space-y-2">
                    {model.supportedReasoningLevels.map((level) => (
                      <div key={level.effort} className="rounded border p-2">
                        <div className="text-sm font-medium">
                          {level.effort}
                        </div>
                        {level.description ? (
                          <div className="text-sm text-muted-foreground">
                            {level.description}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {model.additionalFields.length > 0 ? (
                <section className="mt-4 rounded-lg border p-3">
                  <h3 className="mb-2 text-sm font-semibold">
                    Additional Fields
                  </h3>
                  <div className="grid grid-cols-1 gap-2">
                    {model.additionalFields.map((field) => (
                      <div key={field.key} className="rounded border p-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          {field.key}
                        </div>
                        <div className="mt-1 break-all font-mono text-xs">
                          {field.value}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </article>
          ))}
        </section>
      </main>
    );
  } catch (error) {
    console.error("[models-page] failed to load models", error);
    return (
      <main className="flex w-full flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
        <h1 className="text-2xl font-bold">Failed to load models</h1>
        <p className="text-sm text-muted-foreground">Please try again later.</p>
      </main>
    );
  }
}
