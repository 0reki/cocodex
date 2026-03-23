"use client";

import type { TeamAccountRecord } from "@workspace/database";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import type { LocaleKey } from "@/locales";
import { TeamAccountRow } from "./team-account-row";

export function TeamAccountsGrid(props: {
  items: TeamAccountRecord[];
  showOwnerColumns: boolean;
  columnCount: number;
  allChecked: boolean;
  selected: Record<string, boolean>;
  actingEmail: string | null;
  creatingAccounts: boolean;
  joiningTeam: boolean;
  bulkRemoving: boolean;
  bulkDisabling: boolean;
  bulkRelogining: boolean;
  t: (key: LocaleKey) => string;
  onToggleAll: (checked: boolean) => void;
  onToggleOne: (email: string, checked: boolean) => void;
  onViewMembers: (email: string) => void;
  onAutoFillMembers: (email: string) => void;
  onRelogin: (email: string) => void;
  onToggleEnabled: (item: TeamAccountRecord) => void;
  onRemove: (email: string) => void;
}) {
  const {
    items,
    showOwnerColumns,
    columnCount,
    allChecked,
    selected,
    actingEmail,
    creatingAccounts,
    joiningTeam,
    bulkRemoving,
    bulkDisabling,
    bulkRelogining,
    t,
    onToggleAll,
    onToggleOne,
    onViewMembers,
    onAutoFillMembers,
    onRelogin,
    onToggleEnabled,
    onRemove,
  } = props;

  return (
    <section className="overflow-x-auto rounded-lg border">
      <Table className="min-w-280">
        <TableHeader>
          <TableRow className="bg-muted/40 text-left">
            <TableHead className="px-3 py-3 font-medium">
              <Checkbox
                checked={allChecked}
                onCheckedChange={(checked) => onToggleAll(checked === true)}
                aria-label="Select all team accounts"
              />
            </TableHead>
            <TableHead className="px-3 py-3 font-medium">{t("common.email")}</TableHead>
            <TableHead className="px-3 py-3 font-medium">{t("accounts.plan")}</TableHead>
            <TableHead className="px-3 py-3 font-medium">{t("common.status")}</TableHead>
            <TableHead className="px-3 py-3 font-medium">{t("accounts.workspace")}</TableHead>
            {showOwnerColumns ? (
              <>
                <TableHead className="px-3 py-3 font-medium">{t("team.memberCount")}</TableHead>
                <TableHead className="px-3 py-3 font-medium">{t("team.expiresAt")}</TableHead>
              </>
            ) : null}
            <TableHead className="px-3 py-3 font-medium">{t("accounts.limit")}</TableHead>
            <TableHead className="px-3 py-3 font-medium">{t("accounts.action")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell className="px-3 py-6 text-muted-foreground" colSpan={columnCount}>
                {t("team.noAccounts")}
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => (
              <TeamAccountRow
                key={item.id}
                item={item}
                showOwnerColumns={showOwnerColumns}
                checked={Boolean(selected[item.email])}
                busy={
                  actingEmail === item.email ||
                  creatingAccounts ||
                  joiningTeam ||
                  bulkRemoving ||
                  bulkDisabling ||
                  bulkRelogining
                }
                acting={actingEmail === item.email}
                t={t}
                onCheckedChange={(checked) => onToggleOne(item.email, checked)}
                onViewMembers={() => onViewMembers(item.email)}
                onAutoFillMembers={() => onAutoFillMembers(item.email)}
                onRelogin={() => onRelogin(item.email)}
                onToggleEnabled={() => onToggleEnabled(item)}
                onRemove={() => onRemove(item.email)}
              />
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}
