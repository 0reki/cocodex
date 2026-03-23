"use client";

import { useMemo } from "react";
import type { TeamTab } from "@/lib/features/team/types/team-types";

export function useTeamTableMeta(props: {
  page: number;
  pageSize: number;
  total: number;
  tab: TeamTab;
  showOwnerColumns: boolean;
  cloudMailDomains: string[];
  ownerMailDomains: string[];
}) {
  const { page, pageSize, total, tab, showOwnerColumns, cloudMailDomains, ownerMailDomains } = props;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const prevPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const columnCount = showOwnerColumns ? 9 : 7;

  const availableCloudMailDomains = useMemo(
    () => cloudMailDomains.filter((item, index, all) => item.trim().length > 0 && all.indexOf(item) === index),
    [cloudMailDomains],
  );
  const availableOwnerMailDomains = useMemo(
    () => ownerMailDomains.filter((item, index, all) => item.trim().length > 0 && all.indexOf(item) === index),
    [ownerMailDomains],
  );
  const availableCreateDomains = tab === "owner" ? availableOwnerMailDomains : availableCloudMailDomains;

  return {
    totalPages,
    prevPage,
    nextPage,
    hasPrev,
    hasNext,
    columnCount,
    availableCreateDomains,
  };
}
