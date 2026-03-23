import { listPortalUsersPage } from "@workspace/database";
import { UsersEditor } from "@/features/users/containers/users-editor";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAdmin } from "@/lib/auth/require-admin";

type SearchParams = Record<string, string | string[] | undefined>;

function getQueryValue(value: string | string[] | undefined) {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? (value[0] ?? "")
      : "";
}

function parsePositiveInt(
  value: string | string[] | undefined,
  fallback: number,
) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAdmin("/users");
  const { t } = await getServerTranslator();
  const query = await searchParams;

  const page = parsePositiveInt(query.page, 1);
  const pageSize = Math.min(100, parsePositiveInt(query.pageSize, 20));
  const search = getQueryValue(query.search).trim();
  const role =
    getQueryValue(query.role) === "admin" ||
    getQueryValue(query.role) === "user"
      ? (getQueryValue(query.role) as "admin" | "user")
      : "all";
  const status =
    getQueryValue(query.status) === "enabled" ||
    getQueryValue(query.status) === "disabled"
      ? (getQueryValue(query.status) as "enabled" | "disabled")
      : "all";

  const users = await listPortalUsersPage(page, pageSize, {
    search,
    role,
    status,
  });

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section>
        <h1 className="text-2xl font-bold">{t("page.users")}</h1>
      </section>
      <UsersEditor
        items={users.items}
        currentUserId={session.sub}
        page={users.page}
        pageSize={users.pageSize}
        total={users.total}
        initialSearch={search}
        initialRoleFilter={role}
        initialStatusFilter={status}
      />
    </main>
  );
}
