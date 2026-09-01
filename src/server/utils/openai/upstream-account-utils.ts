import type { OpenAIAccountRecord } from "../../../database/index.ts";

export type UpstreamSourceAccountRecord = OpenAIAccountRecord;

export function resolveOpenAIUpstreamAccountId(
  account: Pick<UpstreamSourceAccountRecord, "accountId" | "userId">,
): string | null {
  return (account.accountId ?? account.userId ?? "").trim() || null;
}
