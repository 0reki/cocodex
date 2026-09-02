import crypto from "node:crypto";

export function prepareResponsesPayload(args: {
  requestBody: Record<string, unknown>;
  ownerUserId: string | null;
  apiKeyId: string | null;
}) {
  const payload = { ...args.requestBody };
  if (
    typeof payload.promptCacheKey === "string" &&
    typeof payload.prompt_cache_key !== "string"
  ) {
    payload.prompt_cache_key = payload.promptCacheKey;
  }
  delete payload.promptCacheKey;
  delete payload.forkedFromIdentifier;
  delete payload.forked_from_identifier;
  delete payload.prompt_cache_retention;
  if (
    typeof payload.prompt_cache_key !== "string" ||
    !payload.prompt_cache_key.trim()
  ) {
    const seed = args.ownerUserId?.trim() || args.apiKeyId?.trim();
    payload.prompt_cache_key = seed
      ? crypto
          .createHash("sha256")
          .update(`prompt-cache:${seed}`)
          .digest("hex")
          .slice(0, 32)
      : crypto.randomUUID();
  }
  return payload;
}
