"use client";

import { useEffect, useMemo, useState } from "react";
import type { LocaleKey } from "@/locales";
import type { AccountFilterKind, AccountItem } from "@/lib/features/accounts/types/account-types";
import { getKindLabel, getStatusLabel } from "@/lib/features/accounts/utils/account-utils";

export function useAccountsTableState(props: {
  items: AccountItem[];
  t: (key: LocaleKey) => string;
}) {
  const { items, t } = props;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<AccountFilterKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled" | "cooling">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return items.filter((item) => {
      const matchesKeyword =
        !keyword ||
        [item.email, item.name ?? "", item.workspaceName ?? "", item.accountId ?? "", getKindLabel(item.kind, t).toLowerCase()].some((value) =>
          value.toLowerCase().includes(keyword),
        );

      const matchesKind =
        kindFilter === "all" ||
        item.kind === kindFilter ||
        (kindFilter === "plus" &&
          item.kind === "openai" &&
          (item.planType ?? "").trim().toLowerCase().includes("plus"));
      const statusLabel = getStatusLabel(item, t);
      const isCooling = item.cooldownUntil != null && Date.parse(item.cooldownUntil) > Date.now();
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && statusLabel === t("status.active")) ||
        (statusFilter === "disabled" && statusLabel === t("status.disabled")) ||
        (statusFilter === "cooling" && isCooling);

      return matchesKeyword && matchesKind && matchesStatus;
    });
  }, [items, search, kindFilter, statusFilter, t]);

  const selectedEmails = useMemo(
    () => filteredItems.filter((item) => selected[item.email]).map((item) => item.email),
    [filteredItems, selected],
  );
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedItems = useMemo(
    () => filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredItems, pageSize, safePage],
  );
  const allChecked = pagedItems.length > 0 && pagedItems.every((item) => selected[item.email]);
  const filterKindOptions: Array<{ value: AccountFilterKind; label: string }> = [
    { value: "all", label: t("accounts.all") },
    { value: "team-owner", label: t("accounts.kindTeamOwner") },
    { value: "team-member", label: t("accounts.kindTeamMember") },
    { value: "plus", label: t("accounts.kindPlus") },
  ];

  useEffect(() => {
    const visibleEmails = new Set(filteredItems.map((item) => item.email));
    setSelected((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([email, checked]) => checked && visibleEmails.has(email))),
    );
  }, [filteredItems]);

  useEffect(() => {
    setPage(1);
  }, [search, kindFilter, statusFilter]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  return {
    selected,
    search,
    kindFilter,
    statusFilter,
    page,
    pageSize,
    filteredItems,
    selectedEmails,
    totalPages,
    safePage,
    pagedItems,
    allChecked,
    filterKindOptions,
    clearSelection: () => setSelected({}),
    setSearch,
    setKindFilter,
    setStatusFilter,
    setPage,
    setPageSize,
    setSelected,
    toggleAll: (checked: boolean) => {
      if (!checked) {
        setSelected({});
        return;
      }
      const next: Record<string, boolean> = {};
      for (const item of pagedItems) {
        next[item.email] = true;
      }
      setSelected(next);
    },
  };
}
