import { redirect } from "next/navigation";
import { ensureDatabaseSchema, getPortalUserById } from "@workspace/database";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { SetupRedirectToast } from "@/components/profile/setup-redirect-toast";
import { getClientTranslator, getServerRequestLocale } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SetupPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requireAuth("/setup");
  const params = (await searchParams) ?? {};
  const setupReason = typeof params.reason === "string" ? params.reason : "";
  const showRedirectToast = setupReason === "setup_required";
  await ensureDatabaseSchema();
  const user = await getPortalUserById(session.sub);
  const locale = await getServerRequestLocale();
  const { t } = getClientTranslator(locale);

  if (!user) {
    return (
      <main className="flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold">{t("status.unauthorized")}</h1>
      </main>
    );
  }

  if (!user.mustSetup) {
    redirect("/api/admin/setup/finish");
  }

  return (
    <main className="flex w-full max-w-368 flex-col gap-6 p-4 sm:p-6">
      <SetupRedirectToast show={showRedirectToast} />
      <section>
        <h1 className="text-2xl font-bold">{t("setup.accountSetupTitle")}</h1>
        <span className="mt-2 block text-sm text-muted-foreground">
          {t("setup.completeProfileHint")}
        </span>
      </section>
      <ProfileEditor
        profile={{
          username: user.username,
          country: user.country,
          mustSetup: user.mustSetup,
        }}
      />
    </main>
  );
}
