import { ensureDatabaseSchema, getPortalUserById } from "@workspace/database";
import { ProfileEditor } from "@/components/profile/profile-editor";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAuth } from "@/lib/auth/require-admin";

export default async function ProfilePage() {
  const session = await requireAuth("/profile");
  const { t } = await getServerTranslator();
  await ensureDatabaseSchema();
  const user = await getPortalUserById(session.sub);

  if (!user) {
    return (
      <main className="flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold">{t("status.unauthorized")}</h1>
      </main>
    );
  }

  return (
    <main className="flex w-full max-w-368 flex-col gap-6 p-4 sm:p-6">
      <section>
        <h1 className="text-2xl font-bold">{t("page.profile")}</h1>
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
