import {
  ensureDatabaseSchema,
  listOpenAIAccountsByUserId,
  listTeamAccountsByUserId,
} from "@workspace/database";
import { AccountsWorkspaceEditor } from "@/features/accounts/containers/accounts-workspace-editor";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";

export default async function AccountsPage() {
  const session = await requireAuth("/accounts");
  const { t } = await getServerTranslator();
  await ensureDatabaseSchema();

  const [openaiAccounts, teamAccounts] = await Promise.all([
    listOpenAIAccountsByUserId(session.sub),
    listTeamAccountsByUserId(session.sub),
  ]);

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">{t("page.accounts")}</h1>
      </section>
      <AccountsWorkspaceEditor
        openaiAccounts={openaiAccounts}
        teamAccounts={teamAccounts}
      />
    </main>
  );
}
