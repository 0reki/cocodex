import type { PostCodexResponsesOptions } from "./runtime.ts";
import { postCodexResponses } from "./responses-stream.ts";
export * from "./responses-shared.ts";
export * from "./responses-stream.ts";
export * from "./responses-websocket.ts";

export type CreateCodexResponseOptions = Omit<
  PostCodexResponsesOptions,
  "version"
> & {
  clientVersion: string;
};

export async function createCodexResponse(
  options: CreateCodexResponseOptions,
): Promise<Response> {
  return postCodexResponses({
    accessToken: options.accessToken,
    accountId: options.accountId,
    version: options.clientVersion,
    sessionId: options.sessionId,
    payload: options.payload,
    proxyUrl: options.proxyUrl,
    userAgent: options.userAgent,
    originator: options.originator,
    webSearchEligible: options.webSearchEligible,
    signal: options.signal,
  });
}
