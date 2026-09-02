import type { OpenAIAccountRecord } from "../../../database/index.ts";

export type UpstreamSourceAccountRecord = OpenAIAccountRecord;

export function resolveOpenAIUpstreamAccountId(
  account: Pick<UpstreamSourceAccountRecord, "accountId">,
): string | null {
  return account.accountId.trim() || null;
}
