import { getSystemSettings, listTeamOwnerAccountsPage } from "@workspace/database";
import { TeamAccountsTable } from "@/features/team/components/team-accounts-table";

export async function TeamOwnerPanel({
  page,
  pageSize,
  q,
}: {
  page: number;
  pageSize: number;
  q: string;
}) {
  const settings = await getSystemSettings();
  const data = await listTeamOwnerAccountsPage(page, pageSize, {
    keyword: q,
  });

  return (
    <TeamAccountsTable
      items={data.items}
      page={data.page}
      pageSize={data.pageSize}
      total={data.total}
      tab="owner"
      keyword={q}
      showOwnerColumns
      ownerMailDomains={settings?.ownerMailDomains ?? []}
    />
  );
}
