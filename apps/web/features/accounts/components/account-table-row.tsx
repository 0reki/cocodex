"use client";

import { EllipsisVertical } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Spinner } from "@workspace/ui/components/spinner";
import { TableCell, TableRow } from "@workspace/ui/components/table";
import type { LocaleKey } from "@/locales";
import type { AccountItem } from "@/lib/features/accounts/types/account-types";
import {
  formatResetAfter,
  getRateLimitWindows,
  getStatusClassName,
  getStatusLabel,
  getStatusVariant,
  toPercent,
  windowLabel,
} from "@/lib/features/accounts/utils/account-utils";

export function AccountTableRow(props: {
  item: AccountItem;
  checked: boolean;
  acting: boolean;
  t: (key: LocaleKey) => string;
  onCheckedChange: (checked: boolean) => void;
  onTest: () => void;
  onViewMembers: () => void;
  onAutoFillMembers: () => void;
  onToggleEnabled: () => void;
  onRelogin: () => void;
  onRemove: () => void;
}) {
  const {
    item,
    checked,
    acting,
    t,
    onCheckedChange,
    onTest,
    onViewMembers,
    onAutoFillMembers,
    onToggleEnabled,
    onRelogin,
    onRemove,
  } = props;

  const rateLimitWindows = getRateLimitWindows(item.rateLimit);
  const isDisabled =
    ("status" in item && (item.status ?? "").trim().toLowerCase() === "disabled") ||
    item.workspaceIsDeactivated;

  return (
    <TableRow className="border-t">
      <TableCell className="px-3 py-3">
        <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(Boolean(value))} />
      </TableCell>
      <TableCell className="px-3 py-3">
        <span className="font-medium">{item.email}</span>
      </TableCell>
      <TableCell className="px-3 py-3">{item.name ?? "-"}</TableCell>
      <TableCell className="px-3 py-3">{item.planType ?? "-"}</TableCell>
      <TableCell className="px-3 py-3">
        <Badge variant={getStatusVariant(item)} className={getStatusClassName(item)}>
          {getStatusLabel(item, t)}
        </Badge>
      </TableCell>
      <TableCell className="px-3 py-3">{item.workspaceName ?? "-"}</TableCell>
      <TableCell className="min-w-56 px-3 py-3">
        {rateLimitWindows.length > 0 ? (
          <div className="flex flex-col gap-2">
            {rateLimitWindows.map((window, index) => (
              <div key={`${item.id}-rate-window-${index}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{windowLabel(window.limitWindowSeconds)}</span>
                  <span>{toPercent(window.usedPercent).toFixed(0)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded bg-emerald-500 transition-all"
                    style={{ width: `${toPercent(window.usedPercent)}%` }}
                  />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {t("accounts.resetIn").replace("{time}", formatResetAfter(window.resetAfterSeconds))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="px-3 py-3 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" disabled={acting}>
              {acting ? <Spinner className="size-4" /> : <EllipsisVertical className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem disabled={acting} onSelect={onTest}>
              {t("accounts.test")}
            </DropdownMenuItem>
            {item.kind === "team-owner" ? (
              <DropdownMenuItem disabled={acting} onSelect={onViewMembers}>
                查看成员
              </DropdownMenuItem>
            ) : null}
            {item.kind === "team-owner" ? (
              <DropdownMenuItem disabled={acting} onSelect={onAutoFillMembers}>
                {t("accounts.autoFillMembersTitle")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={acting} onSelect={onToggleEnabled}>
              {isDisabled ? t("common.enable") : t("common.disable")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={acting} onSelect={onRelogin}>
              {t("team.relogin")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={acting} onSelect={onRemove}>
              {t("accounts.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
