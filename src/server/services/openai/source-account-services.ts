import type { OpenAIAccountRecord } from "../../../database/index.ts";

export function createSourceAccountServices(deps: {
  ensureDatabaseSchema: () => Promise<void>;
  getActiveOpenAIAccount: () => Promise<OpenAIAccountRecord | null>;
}) {
  async function getActiveSourceAccount() {
    await deps.ensureDatabaseSchema();
    return deps.getActiveOpenAIAccount();
  }

  return {
    getActiveSourceAccount,
  };
}
