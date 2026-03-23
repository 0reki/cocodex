import type { OpenAIAccountRecord, TeamAccountRecord } from "@workspace/database";

export type UpstreamSourceAccountRecord = OpenAIAccountRecord | TeamAccountRecord;

export function isOpenAIUpstreamSourceAccount(
  account: UpstreamSourceAccountRecord,
): account is OpenAIAccountRecord {
  return "sessionToken" in account;
}

export function resolveOpenAIUpstreamAccountId(
  account: Pick<UpstreamSourceAccountRecord, "accountId" | "userId">,
): string | null {
  return (account.accountId ?? account.userId ?? "").trim() || null;
}
