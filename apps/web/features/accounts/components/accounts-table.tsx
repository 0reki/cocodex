"use client";

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
import type { AccountItem } from "@/lib/features/accounts/types/account-types";
import { AccountTableRow } from "./account-table-row";

export function AccountsTable(props: {
  filteredItems: AccountItem[];
  pagedItems: AccountItem[];
  selected: Record<string, boolean>;
  allChecked: boolean;
  actingEmail: string | null;
  t: (key: LocaleKey) => string;
  onToggleAll: (checked: boolean) => void;
  onSetSelected: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  onTest: (item: AccountItem) => void;
  onViewMembers: (item: AccountItem) => void;
  onAutoFillMembers: (item: AccountItem) => void;
  onToggleEnabled: (item: AccountItem) => void;
  onRelogin: (item: AccountItem) => void;
  onRemove: (email: string) => void;
}) {
  const {
    filteredItems,
    pagedItems,
    selected,
    allChecked,
    actingEmail,
    t,
    onToggleAll,
    onSetSelected,
    onTest,
    onViewMembers,
    onAutoFillMembers,
    onToggleEnabled,
    onRelogin,
    onRemove,
  } = props;

  return (
    <div className="overflow-hidden rounded-2xl border">
      <Table className="min-w-220">
        <TableHeader>
          <TableRow>
            <TableHead className="w-12 px-3 py-3">
              <Checkbox checked={allChecked} onCheckedChange={(checked) => onToggleAll(Boolean(checked))} />
            </TableHead>
            <TableHead className="px-3 py-3">{t("accounts.email")}</TableHead>
            <TableHead className="px-3 py-3">{t("accounts.name")}</TableHead>
            <TableHead className="px-3 py-3">{t("accounts.plan")}</TableHead>
            <TableHead className="px-3 py-3">{t("common.status")}</TableHead>
            <TableHead className="px-3 py-3">{t("accounts.workspace")}</TableHead>
            <TableHead className="px-3 py-3">{t("accounts.limit")}</TableHead>
            <TableHead className="w-16 px-3 py-3 text-right">{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredItems.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                {t("accounts.noAccounts")}
              </TableCell>
            </TableRow>
          ) : (
            pagedItems.map((item) => (
              <AccountTableRow
                key={`${item.kind}:${item.email}`}
                item={item}
                checked={Boolean(selected[item.email])}
                acting={actingEmail === item.email}
                t={t}
                onCheckedChange={(checked) =>
                  onSetSelected((prev) => ({
                    ...prev,
                    [item.email]: checked,
                  }))
                }
                onTest={() => onTest(item)}
                onViewMembers={() => onViewMembers(item)}
                onAutoFillMembers={() => onAutoFillMembers(item)}
                onToggleEnabled={() => onToggleEnabled(item)}
                onRelogin={() => onRelogin(item)}
                onRemove={() => onRemove(item.email)}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
