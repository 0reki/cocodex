import { ensureDatabaseSchema } from "@workspace/database";
import Link from "next/link";
import { TeamMemberPanel } from "@/features/team/containers/team-member-panel";
import { TeamOwnerPanel } from "@/features/team/containers/team-owner-panel";
import { getServerTranslator } from "@/lib/i18n/i18n";
import { requireAdmin } from "@/lib/auth/require-admin";
import { cn } from "@workspace/ui/lib/utils";

type SearchParams = Record<string, string | string[] | undefined>;
type TeamTab = "owner" | "member";

function pickTeamTab(value: string | string[] | undefined): TeamTab {
  const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  return raw === "owner" ? "owner" : "member";
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

function buildTeamHref(tab: TeamTab, query: SearchParams) {
  const params = new URLSearchParams({ tab });
  const page = String(parsePositiveInt(query.page, 1));
  const pageSize = String(Math.min(200, parsePositiveInt(query.pageSize, 20)));
  const rawQ = Array.isArray(query.q) ? (query.q[0] ?? "") : (query.q ?? "");

  params.set("page", page);
  params.set("pageSize", pageSize);
  if (rawQ.trim()) {
    params.set("q", rawQ.trim());
  }
  return `/team?${params.toString()}`;
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin("/team");
  await ensureDatabaseSchema();
  const { t } = await getServerTranslator();
  const query = await searchParams;
  const tab = pickTeamTab(query.tab);
  const page = parsePositiveInt(query.page, 1);
  const pageSize = Math.min(200, parsePositiveInt(query.pageSize, 20));
  const q = Array.isArray(query.q) ? (query.q[0] ?? "") : (query.q ?? "");

  return (
    <main className="flex w-full flex-col gap-6 px-3 py-3 sm:px-4 sm:py-4 lg:px-5">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("page.team")}</h1>
        <div className="inline-flex w-fit items-center rounded-lg border bg-background p-1">
          <Link
            href={buildTeamHref("member", query)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === "member" ? "bg-muted font-medium" : "hover:bg-muted/60",
            )}
          >
            {t("team.member")}
          </Link>
          <Link
            href={buildTeamHref("owner", query)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === "owner" ? "bg-muted font-medium" : "hover:bg-muted/60",
            )}
          >
            {t("team.owner")}
          </Link>
        </div>
      </section>

      {tab === "member" ? (
        <TeamMemberPanel page={page} pageSize={pageSize} q={q} />
      ) : (
        <TeamOwnerPanel page={page} pageSize={pageSize} q={q} />
      )}
    </main>
  );
}
