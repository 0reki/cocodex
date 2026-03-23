"use client";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import type { LocaleKey } from "@/locales";
import type { BatchAction, UserItem } from "@/lib/features/users/types/user-types";

export function UserTableRow(props: {
  item: UserItem;
  checked: boolean;
  locale: string;
  currentUserId: string;
  t: (key: LocaleKey) => string;
  onCheckedChange: (checked: boolean) => void;
  onEdit: () => void;
  onEditBalance: () => void;
  onConfirm: (action: BatchAction) => void;
}) {
  const {
    item,
    checked,
    locale,
    currentUserId,
    t,
    onCheckedChange,
    onEdit,
    onEditBalance,
    onConfirm,
  } = props;
  const isSelf = item.id === currentUserId;

  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-3">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-label={`Select ${item.username}`}
        />
      </td>
      <td className="px-3 py-3 font-medium">{item.username}</td>
      <td className="px-3 py-3">{item.role === "admin" ? t("users.admin") : t("users.user")}</td>
      <td className="px-3 py-3">
        <Badge variant={item.enabled ? "secondary" : "destructive"}>
          {item.enabled ? t("status.enabled") : t("status.disabled")}
        </Badge>
      </td>
      <td className="px-3 py-3">{`$${item.balance.toFixed(1)}`}</td>
      <td className="px-3 py-3">{new Date(item.createdAt).toLocaleString(locale)}</td>
      <td className="px-3 py-3">
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onEdit}>
            {t("common.edit")}
          </Button>
          <Button type="button" variant="outline" onClick={onEditBalance}>
            {t("users.editBalance")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSelf}
            onClick={() => onConfirm(item.enabled ? "disable" : "enable")}
          >
            {item.enabled ? t("common.disable") : t("common.enable")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isSelf}
            onClick={() => onConfirm("delete")}
          >
            {t("common.delete")}
          </Button>
        </div>
      </td>
    </tr>
  );
}
