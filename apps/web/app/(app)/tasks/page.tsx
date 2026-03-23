import { OpenAISignup } from "@/features/signup/containers/openai-signup";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAdmin } from "@/lib/auth/require-admin";

export default async function TasksPage({
  searchParams: _searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin("/tasks");
  await _searchParams;
  const { t } = await getServerTranslator();

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("signup.tasks")}</h1>
      </section>
      <OpenAISignup />
    </main>
  );
}
