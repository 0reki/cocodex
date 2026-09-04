import {
  extractResponseErrorPayload,
  isRecord,
} from "../../openai-response-utils.ts";
import {
  divideUsdAmount,
  parseUsdAmount,
  type UsdAmount,
} from "../../../shared/usd.ts";
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

function getTokenCount(
  source: Record<string, unknown> | null,
  keys: string[],
): number | null {
  const value = getNestedNumberFromRecord(source, keys);
  return value === null ? null : Math.max(0, Math.trunc(value));
}

function extractImageTokenUsage(
  usage: Record<string, unknown> | null,
): Record<string, number> | null {
  if (!usage) return null;
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : null;
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : null;
  const values = {
    input_tokens: getTokenCount(usage, ["input_tokens", "inputTokens"]),
    cached_input_tokens:
      getTokenCount(usage, ["cached_input_tokens", "cachedInputTokens"]) ??
      getTokenCount(inputDetails, ["cached_tokens", "cachedTokens"]),
    cached_text_input_tokens: getTokenCount(inputDetails, [
      "cached_text_tokens",
      "cachedTextTokens",
    ]),
    cached_image_input_tokens: getTokenCount(inputDetails, [
      "cached_image_tokens",
      "cachedImageTokens",
    ]),
    input_text_tokens: getTokenCount(inputDetails, [
      "text_tokens",
      "textTokens",
    ]),
    input_image_tokens: getTokenCount(inputDetails, [
      "image_tokens",
      "imageTokens",
    ]),
    output_tokens: getTokenCount(usage, ["output_tokens", "outputTokens"]),
    output_text_tokens: getTokenCount(outputDetails, [
      "text_tokens",
      "textTokens",
    ]),
    output_image_tokens: getTokenCount(outputDetails, [
      "image_tokens",
      "imageTokens",
    ]),
    total_tokens: getTokenCount(usage, ["total_tokens", "totalTokens"]),
  };
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, number] => entry[1] !== null,
    ),
  );
}

export function createModelServices(deps: {
  priceAfter272kInputThresholdTokens: number;
  modelPricing: Array<Record<string, unknown>>;
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

    const inputTokens = getNestedNumberFromRecord(usageRaw, [
      "input_tokens",
      "inputTokens",
    ]);
    const outputTokens = getNestedNumberFromRecord(usageRaw, [
      "output_tokens",
      "outputTokens",
    ]);
    const inputTokenDetails = isRecord(usageRaw?.input_tokens_details)
      ? usageRaw.input_tokens_details
      : null;
    const outputTokenDetails = isRecord(usageRaw?.output_tokens_details)
      ? usageRaw.output_tokens_details
      : null;
    const cachedInputTokens =
      getNestedNumberFromRecord(usageRaw, [
        "cached_input_tokens",
        "cachedInputTokens",
      ]) ??
      getNestedNumberFromRecord(inputTokenDetails, [
        "cached_tokens",
        "cachedTokens",
      ]);
    const cacheWriteInputTokens =
      getNestedNumberFromRecord(usageRaw, [
        "cache_write_input_tokens",
        "cacheWriteInputTokens",
      ]) ??
      getNestedNumberFromRecord(inputTokenDetails, [
        "cache_write_tokens",
        "cacheWriteTokens",
      ]);
    const reasoningOutputTokens =
      getNestedNumberFromRecord(usageRaw, [
        "reasoning_output_tokens",
        "reasoningOutputTokens",
      ]) ??
      getNestedNumberFromRecord(outputTokenDetails, [
        "reasoning_tokens",
        "reasoningTokens",
      ]);
    const imageTokenUsage = extractImageTokenUsage(usageRaw);
    const toolUsage = isRecord(usageRaw?.tool_usage)
      ? usageRaw.tool_usage
      : isRecord(usageRaw?.toolUsage)
        ? usageRaw.toolUsage
        : null;
    const imageGenerationUsage = extractImageTokenUsage(
      isRecord(toolUsage?.image_gen)
        ? toolUsage.image_gen
        : isRecord(toolUsage?.imageGeneration)
          ? toolUsage.imageGeneration
          : null,
    );
    const totalTokens =
      getNestedNumberFromRecord(usageRaw, ["total_tokens", "totalTokens"]) ??
      (() => {
        const sum = (inputTokens ?? 0) + (outputTokens ?? 0);
        return sum > 0 ? sum : null;
      })();
    const tokensInfo: Record<string, unknown> | null = usageRaw
      ? Object.fromEntries(
          Object.entries({
            input_tokens: inputTokens,
            cached_input_tokens: cachedInputTokens,
            cache_write_input_tokens: cacheWriteInputTokens,
            input_text_tokens: imageTokenUsage?.input_text_tokens ?? null,
            input_image_tokens: imageTokenUsage?.input_image_tokens ?? null,
            cached_text_input_tokens:
              imageTokenUsage?.cached_text_input_tokens ?? null,
            cached_image_input_tokens:
              imageTokenUsage?.cached_image_input_tokens ?? null,
            output_tokens: outputTokens,
            reasoning_output_tokens: reasoningOutputTokens,
            output_text_tokens: imageTokenUsage?.output_text_tokens ?? null,
            output_image_tokens: imageTokenUsage?.output_image_tokens ?? null,
            total_tokens: totalTokens,
          }).filter((entry): entry is [string, number] => entry[1] !== null),
        )
      : null;
    if (tokensInfo && imageGenerationUsage) {
      tokensInfo.image_generation = imageGenerationUsage;
    }

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
      tokensInfo,
      totalTokens,
      errorCode,
      errorMessage,
    };
  }

  function findModelPricing(modelId: string | null) {
    if (!modelId) return null;
    const resolvedModelId = modelId.trim();
    if (!resolvedModelId) return null;
    const baseModelId = resolvedModelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const candidateModelIds =
      baseModelId !== resolvedModelId
        ? [baseModelId, resolvedModelId]
        : [resolvedModelId];
    return (
      deps.modelPricing.find(
        (item) =>
          typeof item.slug === "string" && candidateModelIds.includes(item.slug),
      ) ?? null
    );
  }

  const readPrice = (value: unknown) => {
    const parsed = parseUsdAmount(value);
    return parsed !== null && parsed >= 0n ? parsed : null;
  };

  function estimateTextUsageCost(
    modelId: string | null,
    tokensInfo: Record<string, unknown> | null,
  ): UsdAmount | null {
    if (!modelId || !tokensInfo) return null;
    const model = findModelPricing(modelId);
    if (!model) return null;

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

    const inputTokens = Math.max(
      0,
      Math.trunc(
        getNestedNumberFromRecord(tokensInfo, [
          "input_tokens",
          "inputTokens",
        ]) ?? 0,
      ),
    );
    const cachedInputTokens = Math.min(
      inputTokens,
      Math.max(
        0,
        Math.trunc(
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
            0,
        ),
      ),
    );
    const cacheWriteInputTokens = Math.min(
      inputTokens - cachedInputTokens,
      Math.max(
        0,
        Math.trunc(
          getNestedNumberFromRecord(tokensInfo, [
            "cache_write_input_tokens",
            "cacheWriteInputTokens",
            "input_tokens_details.cache_write_tokens",
          ]) ??
            getNestedNumberFromRecord(
              isRecord(tokensInfo.input_tokens_details)
                ? (tokensInfo.input_tokens_details as Record<string, unknown>)
                : null,
              ["cache_write_tokens"],
            ) ??
            0,
        ),
      ),
    );
    const billableInputTokens = Math.max(
      0,
      inputTokens - cachedInputTokens - cacheWriteInputTokens,
    );
    const outputTokens = Math.max(
      0,
      Math.trunc(
        getNestedNumberFromRecord(tokensInfo, [
          "output_tokens",
          "outputTokens",
        ]) ?? 0,
      ),
    );
    const totalInputTokens = inputTokens;
    const pricedInputTokens = billableInputTokens + cachedInputTokens;

    let totalPriceWeightedTokens = 0n;
    let hasCost = false;
    const addCost = (tokens: number, rate: UsdAmount | null) => {
      if (rate === null || tokens <= 0) return;
      totalPriceWeightedTokens += BigInt(tokens) * rate;
      hasCost = true;
    };
    const resolvedCachedInputRate = cachedInputRate ?? inputRate;
    if (!hasExplicitAfter400kPricing && !doublesAfter400k) {
      addCost(billableInputTokens, inputRate);
      addCost(cachedInputTokens, resolvedCachedInputRate);
      addCost(outputTokens, outputRate);
      return hasCost
        ? divideUsdAmount(totalPriceWeightedTokens, 1_000_000n)
        : null;
    }

    const overflowInputRate =
      inputRateAfter400k ??
      (hasExplicitAfter400kPricing
        ? inputRate
        : inputRate !== null && doublesAfter400k
          ? inputRate * 2n
          : inputRate);
    const overflowCachedInputRate =
      cachedInputRateAfter400k ??
      (hasExplicitAfter400kPricing
        ? resolvedCachedInputRate
        : resolvedCachedInputRate !== null && doublesAfter400k
          ? resolvedCachedInputRate * 2n
          : resolvedCachedInputRate);
    const overflowOutputRate =
      outputRateAfter400k ??
      (hasExplicitAfter400kPricing
        ? outputRate
        : outputRate !== null && doublesAfter400k
          ? outputRate * 2n
          : outputRate);

    const regularInputTokens = Math.min(
      totalInputTokens,
      deps.priceAfter272kInputThresholdTokens,
    );
    const regularPricedInputTokens =
      totalInputTokens > 0
        ? Math.floor(
            (pricedInputTokens * regularInputTokens) / totalInputTokens,
          )
        : 0;
    const regularBillableInputTokens =
      pricedInputTokens > 0
        ? Math.floor(
            (billableInputTokens * regularPricedInputTokens) /
              pricedInputTokens,
          )
        : 0;
    const regularCachedInputTokens =
      regularPricedInputTokens - regularBillableInputTokens;
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

    addCost(regularBillableInputTokens, inputRate);
    addCost(regularCachedInputTokens, resolvedCachedInputRate);
    addCost(regularOutputTokens, outputRate);
    addCost(overflowBillableInputTokens, overflowInputRate);
    addCost(overflowCachedInputTokens, overflowCachedInputRate);
    addCost(overflowOutputTokens, overflowOutputRate);
    return hasCost
      ? divideUsdAmount(totalPriceWeightedTokens, 1_000_000n)
      : null;
  }

  function estimateImageUsageCost(
    tokensInfo: Record<string, unknown> | null,
  ): UsdAmount | null {
    if (!tokensInfo) return null;
    const model = findModelPricing("gpt-image-2");
    if (!model) return null;

    const textInputRate = readPrice(model.text_input_price_per_million);
    const cachedTextInputRate =
      readPrice(model.cached_text_input_price_per_million) ?? textInputRate;
    const textOutputRate = readPrice(model.text_output_price_per_million);
    const imageInputRate = readPrice(model.image_input_price_per_million);
    const cachedImageInputRate =
      readPrice(model.cached_image_input_price_per_million) ?? imageInputRate;
    const imageOutputRate = readPrice(model.image_output_price_per_million);

    const declaredInputTokens =
      getTokenCount(tokensInfo, ["input_tokens", "inputTokens"]) ?? 0;
    const textInputTokens =
      getTokenCount(tokensInfo, ["input_text_tokens", "inputTextTokens"]) ?? 0;
    let imageInputTokens =
      getTokenCount(tokensInfo, ["input_image_tokens", "inputImageTokens"]) ?? 0;
    imageInputTokens += Math.max(
      0,
      declaredInputTokens - textInputTokens - imageInputTokens,
    );

    const declaredOutputTokens =
      getTokenCount(tokensInfo, ["output_tokens", "outputTokens"]) ?? 0;
    const textOutputTokens =
      getTokenCount(tokensInfo, ["output_text_tokens", "outputTextTokens"]) ?? 0;
    let imageOutputTokens =
      getTokenCount(tokensInfo, ["output_image_tokens", "outputImageTokens"]) ?? 0;
    imageOutputTokens += Math.max(
      0,
      declaredOutputTokens - textOutputTokens - imageOutputTokens,
    );

    const cachedInputTokens = Math.min(
      textInputTokens + imageInputTokens,
      getTokenCount(tokensInfo, ["cached_input_tokens", "cachedInputTokens"]) ??
        0,
    );
    let cachedTextInputTokens = Math.min(
      textInputTokens,
      getTokenCount(tokensInfo, [
        "cached_text_input_tokens",
        "cachedTextInputTokens",
      ]) ?? 0,
    );
    let cachedImageInputTokens = Math.min(
      imageInputTokens,
      getTokenCount(tokensInfo, [
        "cached_image_input_tokens",
        "cachedImageInputTokens",
      ]) ?? 0,
    );
    const unassignedCachedTokens = Math.max(
      0,
      cachedInputTokens - cachedTextInputTokens - cachedImageInputTokens,
    );
    const remainingInputTokens =
      textInputTokens +
      imageInputTokens -
      cachedTextInputTokens -
      cachedImageInputTokens;
    if (unassignedCachedTokens > 0 && remainingInputTokens > 0) {
      const additionalImageCachedTokens = Math.min(
        imageInputTokens - cachedImageInputTokens,
        Math.floor(
          (unassignedCachedTokens *
            (imageInputTokens - cachedImageInputTokens)) /
            remainingInputTokens,
        ),
      );
      cachedImageInputTokens += additionalImageCachedTokens;
      cachedTextInputTokens += Math.min(
        textInputTokens - cachedTextInputTokens,
        unassignedCachedTokens - additionalImageCachedTokens,
      );
    }

    let weightedTokens = 0n;
    let hasCost = false;
    const addCost = (tokens: number, rate: UsdAmount | null) => {
      if (rate === null || tokens <= 0) return;
      weightedTokens += BigInt(tokens) * rate;
      hasCost = true;
    };
    addCost(textInputTokens - cachedTextInputTokens, textInputRate);
    addCost(cachedTextInputTokens, cachedTextInputRate);
    addCost(imageInputTokens - cachedImageInputTokens, imageInputRate);
    addCost(cachedImageInputTokens, cachedImageInputRate);
    addCost(textOutputTokens, textOutputRate);
    addCost(imageOutputTokens, imageOutputRate);
    return hasCost ? divideUsdAmount(weightedTokens, 1_000_000n) : null;
  }

  function resolveUsagePricingModelId(
    modelId: string | null,
    requestPayload: Record<string, unknown> | null,
  ): string | null {
    const accessPrograms = isRecord(requestPayload?.access_programs)
      ? requestPayload.access_programs
      : null;
    const cyber =
      typeof accessPrograms?.cyber === "string"
        ? accessPrograms.cyber.trim().toLowerCase()
        : "";
    if (cyber === "daybreak_blue" || cyber === "daybreak_red") return cyber;
    return modelId;
  }

  function estimateUsageCost(
    modelId: string | null,
    tokensInfo: Record<string, unknown> | null,
  ): UsdAmount | null {
    if (!tokensInfo) return null;
    const isImageModel = modelId
      ?.trim()
      .replace(/-\d{4}-\d{2}-\d{2}$/, "") === "gpt-image-2";
    const primaryCost = isImageModel
      ? estimateImageUsageCost(tokensInfo)
      : estimateTextUsageCost(modelId, tokensInfo);
    const imageGenerationCost = isRecord(tokensInfo.image_generation)
      ? estimateImageUsageCost(tokensInfo.image_generation)
      : null;
    if (primaryCost === null && imageGenerationCost === null) return null;
    return (primaryCost ?? 0n) + (imageGenerationCost ?? 0n);
  }

  return {
    buildOpenAIModelsList,
    extractResponseUsage,
    estimateUsageCost,
    resolveUsagePricingModelId,
  };
}
