"use client";

import { Checkbox } from "@workspace/ui/components/checkbox";
import type { LocaleKey } from "@/locales";
import type { BatchAction, UserItem } from "@/lib/features/users/types/user-types";
import { UserTableRow } from "./user-table-row";

export function UsersTable(props: {
  items: UserItem[];
  selectedIdSet: Set<string>;
  allChecked: boolean;
  locale: string;
  currentUserId: string;
  t: (key: LocaleKey) => string;
  onToggleAll: (checked: boolean) => void;
  onToggleRowSelected: (id: string, checked: boolean) => void;
  onEdit: (item: UserItem) => void;
  onEditBalance: (item: UserItem) => void;
  onConfirm: (item: UserItem, action: BatchAction) => void;
}) {
  const {
    items,
    selectedIdSet,
    allChecked,
    locale,
    currentUserId,
    t,
    onToggleAll,
    onToggleRowSelected,
    onEdit,
    onEditBalance,
    onConfirm,
  } = props;

  return (
    <section className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-220 text-sm">
        <thead className="border-b bg-muted/30">
          <tr>
            <th className="px-3 py-2 text-left font-medium">
              <Checkbox
                checked={allChecked}
                onCheckedChange={(checked) => onToggleAll(checked === true)}
                aria-label="Select all users"
              />
            </th>
            <th className="px-3 py-2 text-left font-medium">{t("users.username")}</th>
            <th className="px-3 py-2 text-left font-medium">{t("users.role")}</th>
            <th className="px-3 py-2 text-left font-medium">{t("common.status")}</th>
            <th className="px-3 py-2 text-left font-medium">{t("billing.balance")}</th>
            <th className="px-3 py-2 text-left font-medium">{t("common.createdAt")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("common.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <UserTableRow
              key={item.id}
              item={item}
              checked={selectedIdSet.has(item.id)}
              locale={locale}
              currentUserId={currentUserId}
              t={t}
              onCheckedChange={(checked) => onToggleRowSelected(item.id, checked)}
              onEdit={() => onEdit(item)}
              onEditBalance={() => onEditBalance(item)}
              onConfirm={(action) => onConfirm(item, action)}
            />
          ))}

          {items.length === 0 ? (
            <tr>
              <td className="px-3 py-6 text-center text-muted-foreground" colSpan={8}>
                {t("users.noUsers")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
