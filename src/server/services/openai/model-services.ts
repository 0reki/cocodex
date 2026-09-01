import {
  extractResponseErrorPayload,
  isRecord,
} from "../../openai-response-utils.ts";
import type { ApiKeyRecord } from "../../../database/index.ts";

export function getNestedNumberFromRecord(
  source: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function createModelServices(deps: {
  priceAfter272kInputThresholdTokens: number;
  modelPricing: Array<Record<string, unknown>>;
  incrementApiKeyUsed: (
    apiKeyId: string,
    amount: number,
  ) => Promise<ApiKeyRecord | null>;
  applyApiKeyCacheUpdate: (updatedKey: ApiKeyRecord) => void;
  adjustPortalUserBalance: (userId: string, delta: number) => Promise<unknown>;
  applyUserBillingAllowanceChargeCache: (
    userId: string,
    charge: {
      chargedFromBalance: number;
    },
  ) => void;
  applyServiceTierBillingMultiplier: (
    cost: number | null,
    serviceTier?: "priority" | null,
  ) => number | null;
}) {
  function buildOpenAIModelsList(sourceModels: Array<Record<string, unknown>>) {
    const seen = new Set<string>();
    const models: Array<{
      id: string;
      object: "model";
      created: number;
      owned_by: string;
    }> = [];

    for (const item of sourceModels) {
      const id = typeof item.slug === "string" ? item.slug.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        object: "model",
        created:
          typeof item.created === "number" && Number.isFinite(item.created)
            ? Math.trunc(item.created)
            : 0,
        owned_by:
          typeof item.owned_by === "string" && item.owned_by.trim()
            ? item.owned_by.trim()
            : "openai",
      });
    }

    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  function extractResponseUsage(responseJson: unknown): {
    tokensInfo: Record<string, unknown> | null;
    totalTokens: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  } {
    if (!responseJson || typeof responseJson !== "object") {
      return {
        tokensInfo: null,
        totalTokens: null,
        errorCode: null,
        errorMessage: null,
      };
    }
    const payload = responseJson as Record<string, unknown>;
    const usageRaw =
      payload.usage && typeof payload.usage === "object"
        ? (payload.usage as Record<string, unknown>)
        : payload.response &&
            typeof payload.response === "object" &&
            (payload.response as Record<string, unknown>).usage &&
            typeof (payload.response as Record<string, unknown>).usage ===
              "object"
          ? ((payload.response as Record<string, unknown>).usage as Record<
              string,
              unknown
            >)
          : null;

    const totalTokens =
      getNestedNumberFromRecord(usageRaw, ["total_tokens", "totalTokens"]) ??
      (() => {
        const inputTokens =
          getNestedNumberFromRecord(usageRaw, ["input_tokens", "inputTokens"]) ?? 0;
        const outputTokens =
          getNestedNumberFromRecord(usageRaw, ["output_tokens", "outputTokens"]) ?? 0;
        const sum = inputTokens + outputTokens;
        return sum > 0 ? sum : null;
      })();

    const errorRaw = extractResponseErrorPayload(payload);
    const errorCode =
      typeof errorRaw?.code === "string"
        ? errorRaw.code
        : typeof payload.code === "string"
          ? payload.code
          : null;
    const errorMessage =
      typeof errorRaw?.message === "string"
        ? errorRaw.message
        : typeof errorRaw?.detail === "string"
          ? errorRaw.detail
          : typeof payload.message === "string"
            ? payload.message
            : typeof payload.detail === "string"
              ? payload.detail
              : null;

    return {
      tokensInfo: usageRaw,
      totalTokens,
      errorCode,
      errorMessage,
    };
  }

  function estimateUsageCost(
    modelId: string | null,
    tokensInfo: Record<string, unknown> | null,
  ): number | null {
    if (!modelId || !tokensInfo) return null;
    const resolvedModelId = modelId.trim();
    if (!resolvedModelId) return null;
    const baseModelId = resolvedModelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const candidateModelIds =
      baseModelId !== resolvedModelId
        ? [baseModelId, resolvedModelId]
        : [resolvedModelId];
    const model = deps.modelPricing.find(
      (item) =>
        typeof item.slug === "string" && candidateModelIds.includes(item.slug),
    );
    if (!model) return null;

    const readPrice = (value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };

    const inputRate = readPrice(model.input_price_per_million);
    const cachedInputRate = readPrice(model.cached_input_price_per_million);
    const outputRate = readPrice(model.output_price_per_million);
    const inputRateAfter400k = readPrice(
      model.input_price_per_million_after_400k_tokens,
    );
    const cachedInputRateAfter400k = readPrice(
      model.cached_input_price_per_million_after_400k_tokens,
    );
    const outputRateAfter400k = readPrice(
      model.output_price_per_million_after_400k_tokens,
    );
    const doublesAfter400k = model.double_price_after_400k_tokens === true;
    const hasExplicitAfter400kPricing =
      inputRateAfter400k !== null ||
      cachedInputRateAfter400k !== null ||
      outputRateAfter400k !== null;

    const inputTokens =
      getNestedNumberFromRecord(tokensInfo, ["input_tokens", "inputTokens"]) ?? 0;
    const cachedInputTokens =
      getNestedNumberFromRecord(tokensInfo, [
        "cached_input_tokens",
        "cachedInputTokens",
        "input_tokens_details.cached_tokens",
      ]) ??
      getNestedNumberFromRecord(
        isRecord(tokensInfo.input_tokens_details)
          ? (tokensInfo.input_tokens_details as Record<string, unknown>)
          : null,
        ["cached_tokens"],
      ) ??
      0;
    const billableInputTokens = Math.max(0, inputTokens - cachedInputTokens);
    const outputTokens =
      getNestedNumberFromRecord(tokensInfo, ["output_tokens", "outputTokens"]) ?? 0;
    const totalInputTokens = billableInputTokens + cachedInputTokens;

    let total = 0;
    let hasCost = false;
    const resolvedCachedInputRate = cachedInputRate ?? inputRate;
    if (!hasExplicitAfter400kPricing && !doublesAfter400k) {
      if (inputRate !== null && billableInputTokens > 0) {
        total += (billableInputTokens * inputRate) / 1_000_000;
        hasCost = true;
      }
      if (resolvedCachedInputRate !== null && cachedInputTokens > 0) {
        total += (cachedInputTokens * resolvedCachedInputRate) / 1_000_000;
        hasCost = true;
      }
      if (outputRate !== null && outputTokens > 0) {
        total += (outputTokens * outputRate) / 1_000_000;
        hasCost = true;
      }
      return hasCost ? Number(total.toFixed(8)) : null;
    }

    const overflowInputRate =
      inputRateAfter400k ??
      (hasExplicitAfter400kPricing
        ? inputRate
        : inputRate !== null && doublesAfter400k
          ? inputRate * 2
          : inputRate);
    const overflowCachedInputRate =
      cachedInputRateAfter400k ??
      (hasExplicitAfter400kPricing
        ? resolvedCachedInputRate
        : resolvedCachedInputRate !== null && doublesAfter400k
          ? resolvedCachedInputRate * 2
          : resolvedCachedInputRate);
    const overflowOutputRate =
      outputRateAfter400k ??
      (hasExplicitAfter400kPricing
        ? outputRate
        : outputRate !== null && doublesAfter400k
          ? outputRate * 2
          : outputRate);

    const regularInputTokens = Math.min(
      totalInputTokens,
      deps.priceAfter272kInputThresholdTokens,
    );
    const regularInputRatio =
      totalInputTokens > 0 ? regularInputTokens / totalInputTokens : 0;
    const regularBillableInputTokens = billableInputTokens * regularInputRatio;
    const regularCachedInputTokens = cachedInputTokens * regularInputRatio;
    const overflowBillableInputTokens = Math.max(
      0,
      billableInputTokens - regularBillableInputTokens,
    );
    const overflowCachedInputTokens = Math.max(
      0,
      cachedInputTokens - regularCachedInputTokens,
    );
    const inputThresholdExceeded =
      totalInputTokens > deps.priceAfter272kInputThresholdTokens;
    const regularOutputTokens = inputThresholdExceeded ? 0 : outputTokens;
    const overflowOutputTokens = inputThresholdExceeded ? outputTokens : 0;

    if (inputRate !== null && regularBillableInputTokens > 0) {
      total += (regularBillableInputTokens * inputRate) / 1_000_000;
      hasCost = true;
    }
    if (resolvedCachedInputRate !== null && regularCachedInputTokens > 0) {
      total += (regularCachedInputTokens * resolvedCachedInputRate) / 1_000_000;
      hasCost = true;
    }
    if (outputRate !== null && regularOutputTokens > 0) {
      total += (regularOutputTokens * outputRate) / 1_000_000;
      hasCost = true;
    }
    if (overflowInputRate !== null && overflowBillableInputTokens > 0) {
      total += (overflowBillableInputTokens * overflowInputRate) / 1_000_000;
      hasCost = true;
    }
    if (overflowCachedInputRate !== null && overflowCachedInputTokens > 0) {
      total +=
        (overflowCachedInputTokens * overflowCachedInputRate) / 1_000_000;
      hasCost = true;
    }
    if (overflowOutputRate !== null && overflowOutputTokens > 0) {
      total += (overflowOutputTokens * overflowOutputRate) / 1_000_000;
      hasCost = true;
    }
    return hasCost ? Number(total.toFixed(8)) : null;
  }

  async function chargeCompletedResponseUsage(args: {
    apiKeyId: string | null;
    ownerUserId: string | null;
    modelId: string | null;
    responsePayload: Record<string, unknown>;
    serviceTier?: "priority" | null;
  }) {
    const { tokensInfo } = extractResponseUsage({
      response: args.responsePayload,
    });
    const cost = deps.applyServiceTierBillingMultiplier(
      estimateUsageCost(args.modelId, tokensInfo),
      args.serviceTier,
    );
    if (
      !args.apiKeyId ||
      typeof cost !== "number" ||
      !Number.isFinite(cost) ||
      cost <= 0
    ) {
      return;
    }

    const updatedKey = await deps.incrementApiKeyUsed(args.apiKeyId, cost);
    if (updatedKey) {
      deps.applyApiKeyCacheUpdate(updatedKey);
    }
    if (!args.ownerUserId) return;

    const chargedFromBalance = cost;
    if (chargedFromBalance > 0) {
      await deps.adjustPortalUserBalance(args.ownerUserId, -chargedFromBalance);
    }
    deps.applyUserBillingAllowanceChargeCache(args.ownerUserId, {
      chargedFromBalance,
    });
  }

  return {
    buildOpenAIModelsList,
    extractResponseUsage,
    estimateUsageCost,
    chargeCompletedResponseUsage,
  };
}
