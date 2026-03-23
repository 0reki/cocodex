"use client";

import { Button } from "@workspace/ui/components/button";
import { Spinner } from "@workspace/ui/components/spinner";
import { TableCell, TableRow } from "@workspace/ui/components/table";
import { CopyButton } from "@/components/common/copy-button";
import type { LocaleKey } from "@/locales";
import type { ApiKeyRecord } from "@/lib/features/api-keys/types/api-key-types";
import { formatMoney, getUsagePercent } from "@/lib/features/api-keys/utils/api-key-utils";

export function ApiKeyRow(props: {
  item: ApiKeyRecord;
  locale: string;
  deletingId: string | null;
  updating: boolean;
  t: (key: LocaleKey) => string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { item, locale, deletingId, updating, t, onEdit, onRemove } = props;

  return (
    <TableRow>
      <TableCell className="px-3 py-2.5 text-sm">{item.name}</TableCell>
      <TableCell className="px-3 py-2.5 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-mono">{item.apiKey || "-"}</span>
          {item.apiKey ? <CopyButton text={item.apiKey} label={t("common.copy")} /> : null}
        </div>
      </TableCell>
      <TableCell className="px-3 py-2.5 text-sm">
        <div className="flex min-w-44 flex-col gap-1">
          <div className="text-xs text-muted-foreground">
            ${formatMoney(item.used)}
            {item.quota == null ? "" : ` / $${formatMoney(item.quota)}`}
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${getUsagePercent(item.used, item.quota)}%` }}
            />
          </div>
        </div>
      </TableCell>
      <TableCell className="px-3 py-2.5 text-sm">
        {item.expiresAt ? new Date(item.expiresAt).toLocaleString(locale) : "-"}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-sm">
        {new Date(item.updatedAt).toLocaleString(locale)}
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right">
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="lg" disabled={Boolean(deletingId) || updating} onClick={onEdit}>
            {t("common.edit")}
          </Button>
          <Button variant="destructive" size="lg" disabled={Boolean(deletingId) || updating} onClick={onRemove}>
            {deletingId === item.id ? (
              <span className="flex w-full justify-center">
                <Spinner />
              </span>
            ) : (
              t("common.remove")
            )}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
