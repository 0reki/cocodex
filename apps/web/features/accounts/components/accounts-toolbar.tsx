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
import type { AccountFilterKind } from "@/lib/features/accounts/types/account-types";
import { selectContentProps } from "@/lib/features/accounts/utils/account-utils";

export function AccountsToolbar(props: {
  search: string;
  kindFilter: AccountFilterKind;
  statusFilter: "all" | "active" | "disabled" | "cooling";
  removing: boolean;
  selectedEmailsCount: number;
  filterKindOptions: Array<{ value: AccountFilterKind; label: string }>;
  t: (key: LocaleKey) => string;
  onSearchChange: (value: string) => void;
  onKindFilterChange: (value: AccountFilterKind) => void;
  onStatusFilterChange: (value: "all" | "active" | "disabled" | "cooling") => void;
  onRefresh: () => void;
  onSubmit: () => void;
  onRemoveSelected: () => void;
}) {
  const {
    search,
    kindFilter,
    statusFilter,
    removing,
    selectedEmailsCount,
    filterKindOptions,
    t,
    onSearchChange,
    onKindFilterChange,
    onStatusFilterChange,
    onRefresh,
    onSubmit,
    onRemoveSelected,
  } = props;

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:flex-1">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("accounts.filterPlaceholder")}
          className="h-8 w-full text-sm sm:max-w-sm"
        />
        <div className="h-8 w-full sm:w-44">
          <Select value={kindFilter} onValueChange={(value) => onKindFilterChange(value as AccountFilterKind)}>
            <SelectTrigger className="h-full w-full text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectContentProps()}>
              {filterKindOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="h-8 w-full sm:w-40">
          <Select
            value={statusFilter}
            onValueChange={(value) => onStatusFilterChange(value as "all" | "active" | "disabled" | "cooling")}
          >
            <SelectTrigger className="h-full w-full text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...selectContentProps()}>
              <SelectItem value="all">{t("accounts.allStatus")}</SelectItem>
              <SelectItem value="active">{t("status.active")}</SelectItem>
              <SelectItem value="disabled">{t("status.disabled")}</SelectItem>
              <SelectItem value="cooling">{t("status.coolingDown")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
        <Button type="button" variant="outline" onClick={onRefresh} className="w-full sm:w-auto">
          {t("common.refresh")}
        </Button>
        <Button type="button" variant="outline" onClick={onSubmit} className="w-full sm:w-auto">
          {t("accounts.submit")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="col-span-2 w-full sm:col-span-1 sm:w-auto"
          disabled={selectedEmailsCount === 0 || removing}
          onClick={onRemoveSelected}
        >
          {t("accounts.remove")}
        </Button>
      </div>
    </div>
  );
}
