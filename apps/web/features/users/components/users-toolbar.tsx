"use client";

import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import type { LocaleKey } from "@/locales";
import type { UserRoleFilter, UserStatusFilter } from "@/lib/features/users/types/user-types";
import { selectContentProps } from "@/lib/features/users/utils/user-utils";

export function UsersToolbar(props: {
  search: string;
  roleFilter: UserRoleFilter;
  statusFilter: UserStatusFilter;
  filteredSelectableCount: number;
  selectedCount: number;
  selectedManageableCount: number;
  canOpenMessageDialog: boolean;
  mutating: boolean;
  t: (key: LocaleKey) => string;
  onSearchChange: (value: string) => void;
  onRoleFilterChange: (value: UserRoleFilter) => void;
  onStatusFilterChange: (value: UserStatusFilter) => void;
  onSelectFiltered: () => void;
  onClearSelection: () => void;
  onOpenMessage: () => void;
  onBatchEnable: () => void;
  onBatchDisable: () => void;
  onBatchDelete: () => void;
}) {
  const {
    search,
    roleFilter,
    statusFilter,
    filteredSelectableCount,
    selectedCount,
    selectedManageableCount,
    canOpenMessageDialog,
    mutating,
    t,
    onSearchChange,
    onRoleFilterChange,
    onStatusFilterChange,
    onSelectFiltered,
    onClearSelection,
    onOpenMessage,
    onBatchEnable,
    onBatchDisable,
    onBatchDelete,
  } = props;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={t("users.searchPlaceholder")}
        className="h-9 w-72"
      />
      <Select value={roleFilter} onValueChange={(value) => onRoleFilterChange(value as UserRoleFilter)}>
        <SelectTrigger className="h-9 w-36" aria-label={t("users.role")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectContentProps()}>
          <SelectItem value="all">{t("common.total")}</SelectItem>
          <SelectItem value="user">{t("users.user")}</SelectItem>
          <SelectItem value="admin">{t("users.admin")}</SelectItem>
        </SelectContent>
      </Select>
      <Select value={statusFilter} onValueChange={(value) => onStatusFilterChange(value as UserStatusFilter)}>
        <SelectTrigger className="h-9 w-36" aria-label={t("common.status")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectContentProps()}>
          <SelectItem value="all">{t("common.total")}</SelectItem>
          <SelectItem value="enabled">{t("status.enabled")}</SelectItem>
          <SelectItem value="disabled">{t("status.disabled")}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        disabled={filteredSelectableCount === 0 || mutating}
        onClick={onSelectFiltered}
      >
        {t("inbox.selectFiltered").replace("{count}", String(filteredSelectableCount))}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={selectedCount === 0 || mutating}
        onClick={onClearSelection}
      >
        {t("inbox.clearSelection")}
      </Button>
      <Button type="button" disabled={!canOpenMessageDialog || mutating} onClick={onOpenMessage}>
        {t("inbox.send")}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={selectedManageableCount === 0 || mutating}
        onClick={onBatchEnable}
      >
        {t("common.enable")} ({selectedManageableCount})
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={selectedManageableCount === 0 || mutating}
        onClick={onBatchDisable}
      >
        {t("common.disable")} ({selectedManageableCount})
      </Button>
      <Button
        type="button"
        variant="destructive"
        disabled={selectedManageableCount === 0 || mutating}
        onClick={onBatchDelete}
      >
        {t("common.delete")} ({selectedManageableCount})
      </Button>
    </div>
  );
}
