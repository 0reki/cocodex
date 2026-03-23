"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { UserRoleFilter, UserStatusFilter } from "@/lib/features/users/types/user-types";

export function useUsersFilters(props: {
  initialSearch: string;
  initialRoleFilter: UserRoleFilter;
  initialStatusFilter: UserStatusFilter;
}) {
  const { initialSearch, initialRoleFilter, initialStatusFilter } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(initialSearch);
  const [roleFilter, setRoleFilter] = useState<UserRoleFilter>(initialRoleFilter);
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>(initialStatusFilter);

  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);

  useEffect(() => {
    setRoleFilter(initialRoleFilter);
  }, [initialRoleFilter]);

  useEffect(() => {
    setStatusFilter(initialStatusFilter);
  }, [initialStatusFilter]);

  const updateQuery = (updates: Record<string, string | number | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, String(value));
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  useEffect(() => {
    const normalizedSearch = search.trim();
    if (normalizedSearch === initialSearch) return;
    const timer = window.setTimeout(() => {
      updateQuery({ search: normalizedSearch || null, page: 1 });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [initialSearch, search, pathname, router, searchParams]);

  return {
    search,
    roleFilter,
    statusFilter,
    setSearch,
    updateQuery,
    onRoleFilterChange: (value: UserRoleFilter) => {
      setRoleFilter(value);
      updateQuery({
        role: value === "all" ? null : value,
        page: 1,
      });
    },
    onStatusFilterChange: (value: UserStatusFilter) => {
      setStatusFilter(value);
      updateQuery({
        status: value === "all" ? null : value,
        page: 1,
      });
    },
  };
}
