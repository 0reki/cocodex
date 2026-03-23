import { SignupProxyPoolEditor } from "@/components/proxies/signup-proxy-pool-editor";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAdmin } from "@/lib/auth/require-admin";

export default async function SignupProxiesPage() {
  await requireAdmin("/proxies");
  const { t } = await getServerTranslator();

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">{t("page.proxies")}</h1>
      </section>
      <SignupProxyPoolEditor />
    </main>
  );
}
