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
import { selectContentProps } from "@/lib/features/accounts/utils/account-utils";

export function AccountsPagination(props: {
  safePage: number;
  totalPages: number;
  pageSize: number;
  t: (key: LocaleKey) => string;
  onPageChange: (value: number | ((current: number) => number)) => void;
  onPageSizeChange: (value: number) => void;
}) {
  const { safePage, totalPages, pageSize, t, onPageChange, onPageSizeChange } = props;

  return (
    <section className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="outline" disabled={safePage <= 1} onClick={() => onPageChange(1)}>
        {t("common.first")}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={safePage <= 1}
        onClick={() => onPageChange((current) => Math.max(1, current - 1))}
      >
        {t("common.prev")}
      </Button>
      <span className="min-w-24 text-center text-sm text-muted-foreground">
        {t("common.page")}: {safePage}/{totalPages}
      </span>
      <div className="h-9 min-w-20">
        <Select
          value={String(pageSize)}
          onValueChange={(value) => {
            onPageSizeChange(Number(value));
            onPageChange(1);
          }}
        >
          <SelectTrigger className="h-full min-w-20" aria-label="Select page size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent {...selectContentProps()}>
            {[10, 20, 50, 100].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={safePage >= totalPages}
        onClick={() => onPageChange((current) => Math.min(totalPages, current + 1))}
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
    </section>
  );
}
