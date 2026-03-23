"use client";

import { Badge } from "@workspace/ui/components/badge";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  TableCell,
  TableRow,
} from "@workspace/ui/components/table";
import type { LocaleKey } from "@/locales";
import type { SignupTask } from "@/lib/features/signup/types/signup-task-types";
import {
  formatDuration,
  formatLocalDateTime,
  getTaskStatusBadgeVariant,
} from "@/lib/features/signup/utils/signup-task-utils";

export function SignupTaskRow(props: {
  task: SignupTask;
  checked: boolean;
  canStart: boolean;
  canStop: boolean;
  canDelete: boolean;
  t: (key: LocaleKey) => string;
  onCheckedChange: (checked: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const { task, checked, canStart, canStop, canDelete, t, onCheckedChange, onStart, onStop, onDelete } = props;

  return (
    <TableRow className="border-t">
      <TableCell className="px-3 py-2">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-label={`Select task ${task.id}`}
        />
      </TableCell>
      <TableCell className="px-3 py-2 text-xs">{task.id}</TableCell>
      <TableCell className="px-3 py-2 text-xs">
        <Badge variant={getTaskStatusBadgeVariant(task.status)}>{task.status}</Badge>
      </TableCell>
      <TableCell className="px-3 py-2 text-xs">{task.savedCount}</TableCell>
      <TableCell className="px-3 py-2 text-xs">{task.count}</TableCell>
      <TableCell className="px-3 py-2 text-xs">
        {task.concurrency}/{task.cpuMaxConcurrency}
      </TableCell>
      <TableCell className="px-3 py-2 text-xs">{formatLocalDateTime(task.startedAt)}</TableCell>
      <TableCell className="px-3 py-2 text-xs">{formatDuration(task.durationMs)}</TableCell>
      <TableCell className="px-3 py-2 text-right">
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={!canStart}
            onClick={onStart}
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("common.start")}
          </button>
          <button
            type="button"
            disabled={!canStop}
            onClick={onStop}
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("common.stop")}
          </button>
          <button
            type="button"
            disabled={!canDelete}
            onClick={onDelete}
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("common.delete")}
          </button>
        </div>
      </TableCell>
    </TableRow>
  );
}
