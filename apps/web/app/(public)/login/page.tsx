import { countPortalUsers, ensureDatabaseSchema } from "@workspace/database";
import {
  getAdminJwtSecret,
  getAdminPassword,
  getAdminUsername,
} from "@/lib/auth/admin-auth";
import { AdminLoginForm } from "@/components/auth/admin-login-form";
import { LoginBackground } from "@/components/layout/login-background";
import { isGoogleLoginConfigured } from "@/lib/auth/google-auth";
import { getClientTranslator, getServerRequestLocale } from "@/lib/i18n/i18n";
import { sanitizeNextPath } from "@/lib/http/request-utils";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type BootstrapCheckCache = {
  expiresAt: number;
  needsBootstrap: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __loginBootstrapCheckCache: BootstrapCheckCache | undefined;
}

const BOOTSTRAP_CHECK_TTL_MS = 30_000;

async function readNeedsBootstrap() {
  const now = Date.now();
  const cached = globalThis.__loginBootstrapCheckCache;
  if (cached && cached.expiresAt > now) {
    return cached.needsBootstrap;
  }

  let needsBootstrap = true;
  try {
    await ensureDatabaseSchema();
    const count = await countPortalUsers();
    needsBootstrap = count === 0;
  } catch {
    needsBootstrap = true;
  }

  globalThis.__loginBootstrapCheckCache = {
    expiresAt: now + BOOTSTRAP_CHECK_TTL_MS,
    needsBootstrap,
  };
  return needsBootstrap;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const locale = await getServerRequestLocale();
  const { t } = getClientTranslator(locale);
  const params = (await searchParams) ?? {};
  const errorCode =
    typeof params.error === "string"
      ? params.error
      : Array.isArray(params.error)
        ? (params.error[0] ?? null)
        : null;
  const nextParam = Array.isArray(params.next) ? params.next[0] : params.next;
  const nextPath = sanitizeNextPath(nextParam ?? "/dashboard");

  const needsBootstrap = await readNeedsBootstrap();
  const missingEnv =
    needsBootstrap &&
    (!getAdminUsername() || !getAdminPassword() || !getAdminJwtSecret());

  return (
    <main
      className="relative min-h-dvh overflow-hidden px-6 select-none"
      style={{ backgroundColor: "rgb(239, 238, 254)" }}
    >
      <LoginBackground />
      <section className="relative mx-auto flex min-h-dvh w-full max-w-140 flex-col items-center justify-center gap-6">
        <div className="flex items-center gap-2 text-lg font-medium">
          <img
            src="/codex-shell-logo.svg"
            alt={t("app.title")}
            width={22}
            height={22}
            className="rounded-sm"
          />
          <span>{t("app.title")}</span>
        </div>
        <div className="space-y-2 text-center">
          <p className="text-foreground text-base">{t("login.subtitle")}</p>
        </div>
        <AdminLoginForm
          missingEnv={missingEnv}
          errorCode={errorCode}
          nextPath={nextPath}
          googleEnabled={isGoogleLoginConfigured()}
          labels={{
            username: t("login.username"),
            password: t("login.password"),
            signIn: t("login.signIn"),
            continueWithGoogle: t("login.continueWithGoogle"),
            missingEnv: t("login.error.missingEnv"),
            invalidPassword: t("login.error.invalidPassword"),
            googleConfig: t("login.error.googleConfig"),
            googleState: t("login.error.googleState"),
            googleFailed: t("login.error.googleFailed"),
            googleNotFound: t("login.error.googleNotFound"),
            googleUnverified: t("login.error.googleUnverified"),
            googleDisabled: t("login.error.googleDisabled"),
          }}
        />
      </section>
    </main>
  );
}
