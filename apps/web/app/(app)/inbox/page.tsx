import { InboxCenter } from "@/features/inbox/containers/inbox-center";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";

export default async function InboxPage() {
  await requireAuth("/inbox");
  const { t } = await getServerTranslator();

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">{t("page.inbox")}</h1>
      </section>
      <InboxCenter />
    </main>
  );
}
