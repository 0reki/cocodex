import type { OpenAIAccountRecord } from "../../../database/index.ts";

export function createSourceAccountServices(deps: {
  listAssignedOpenAIAccounts: () => Promise<
    Array<{ ownerUserId: string; account: OpenAIAccountRecord }>
  >;
}) {
  const assignedAccounts = new Map<string, OpenAIAccountRecord>();

  async function hydrateSourceAccountCache() {
    const assignments = await deps.listAssignedOpenAIAccounts();
    assignedAccounts.clear();
    const accountsById = new Map<string, OpenAIAccountRecord>();
    for (const assignment of assignments) {
      const account =
        accountsById.get(assignment.account.id) ?? assignment.account;
      accountsById.set(account.id, account);
      assignedAccounts.set(assignment.ownerUserId, account);
    }
    return assignments.map((assignment) => ({
      ...assignment,
      account: accountsById.get(assignment.account.id) ?? assignment.account,
    }));
  }

  async function invalidateActiveSourceAccount() {
    return hydrateSourceAccountCache();
  }

  function getAssignedSourceAccount(ownerUserId: string) {
    const normalized = ownerUserId.trim();
    if (!normalized) return null;
    const account = assignedAccounts.get(normalized) ?? null;
    if (
      !account ||
      account.status === "disabled" ||
      !account.accountId.trim() ||
      !account.accessToken.trim()
    ) {
      return null;
    }
    return account;
  }

  return {
    getAssignedSourceAccount,
    hydrateSourceAccountCache,
    invalidateActiveSourceAccount,
  };
}
