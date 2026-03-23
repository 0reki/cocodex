"use client";

import { Button } from "@workspace/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import type { LocaleKey } from "@/locales";
import { selectContentProps } from "@/lib/features/users/utils/user-utils";

export function UsersPagination(props: {
  safePage: number;
  totalPages: number;
  pageSize: number;
  t: (key: LocaleKey) => string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { safePage, totalPages, pageSize, t, onPageChange, onPageSizeChange } = props;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="outline" disabled={safePage <= 1} onClick={() => onPageChange(1)}>
        {t("common.first")}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={safePage <= 1}
        onClick={() => onPageChange(Math.max(1, safePage - 1))}
      >
        {t("common.prev")}
      </Button>
      <span className="min-w-24 text-center text-sm text-muted-foreground">
        {t("common.page")}: {safePage}/{totalPages}
      </span>
      <Select
        value={String(pageSize)}
        onValueChange={(value) => {
          const next = Number(value);
          if (!Number.isFinite(next)) return;
          onPageSizeChange(next);
          onPageChange(1);
        }}
      >
        <SelectTrigger className="h-9 w-28" aria-label={t("common.page")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent {...selectContentProps()}>
          <SelectItem value="10">10</SelectItem>
          <SelectItem value="20">20</SelectItem>
          <SelectItem value="50">50</SelectItem>
          <SelectItem value="100">100</SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        disabled={safePage >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
      >
        {t("common.next")}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={safePage >= totalPages}
        onClick={() => onPageChange(totalPages)}
      >
        {t("common.last")}
      </Button>
    </div>
  );
}
