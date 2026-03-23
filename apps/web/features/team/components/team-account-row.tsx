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
import type { TeamAccountRecord } from "@workspace/database";
import type { LocaleKey } from "@/locales";
import {
  LocalDateTime,
  formatResetAfter,
  getRateLimitWindows,
  getStatusClassName,
  getStatusLabel,
  getStatusVariant,
  toPercent,
  windowLabel,
} from "@/lib/features/team/utils/team-utils";

export function TeamAccountRow(props: {
  item: TeamAccountRecord;
  showOwnerColumns: boolean;
  checked: boolean;
  busy: boolean;
  acting: boolean;
  t: (key: LocaleKey) => string;
  onCheckedChange: (checked: boolean) => void;
  onViewMembers: () => void;
  onAutoFillMembers: () => void;
  onRelogin: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
}) {
  const {
    item,
    showOwnerColumns,
    checked,
    busy,
    acting,
    t,
    onCheckedChange,
    onViewMembers,
    onAutoFillMembers,
    onRelogin,
    onToggleEnabled,
    onRemove,
  } = props;

  const rateLimitWindows = getRateLimitWindows(item.rateLimit);
  const isDisabled = item.workspaceIsDeactivated;

  return (
    <TableRow className="border-t">
      <TableCell className="px-3 py-3">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-label={`Select ${item.email}`}
        />
      </TableCell>
      <TableCell className="px-3 py-3">{item.email}</TableCell>
      <TableCell className="px-3 py-3">{item.planType ?? "-"}</TableCell>
      <TableCell className="px-3 py-3">
        <Badge variant={getStatusVariant(item)} className={getStatusClassName(item)}>
          {getStatusLabel(item, t)}
        </Badge>
      </TableCell>
      <TableCell className="px-3 py-3">{item.workspaceName ?? "-"}</TableCell>
      {showOwnerColumns ? (
        <>
          <TableCell className="px-3 py-3">{item.teamMemberCount ?? "-"}</TableCell>
          <TableCell className="px-3 py-3">
            <LocalDateTime value={item.teamExpiresAt} />
          </TableCell>
        </>
      ) : null}
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
      <TableCell className="px-3 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="default" className="px-3 text-sm font-medium" disabled={busy}>
              {acting ? <Spinner /> : <EllipsisVertical className="size-4" aria-hidden="true" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {showOwnerColumns ? (
              <DropdownMenuItem onSelect={onViewMembers}>查看成员</DropdownMenuItem>
            ) : null}
            {showOwnerColumns ? (
              <DropdownMenuItem onSelect={onAutoFillMembers}>
                {t("accounts.autoFillMembersTitle")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={onRelogin}>{t("team.relogin")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleEnabled}>
              {isDisabled ? t("common.enable") : t("common.disable")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              {t("common.remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
