import { getSystemSettings, listTeamMemberAccountsPage } from "@workspace/database";
import { TeamAccountsTable } from "@/features/team/components/team-accounts-table";

export async function TeamMemberPanel({
  page,
  pageSize,
  q,
}: {
  page: number;
  pageSize: number;
  q: string;
}) {
  const settings = await getSystemSettings();
  const data = await listTeamMemberAccountsPage(page, pageSize, {
    keyword: q,
  });

  return (
    <TeamAccountsTable
      items={data.items}
      page={data.page}
      pageSize={data.pageSize}
      total={data.total}
      tab="member"
      keyword={q}
      showOwnerColumns={false}
      cloudMailDomains={settings?.cloudMailDomains ?? []}
    />
  );
}
