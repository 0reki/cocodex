"use client";

import { useToast } from "@/components/providers/toast-provider";
import { Checkbox } from "@workspace/ui/components/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { useLocale } from "@/components/providers/locale-provider";
import { SignupTaskRow } from "../components/signup-task-row";
import { useSignupTasks } from "../hooks/use-signup-tasks";

export function OpenAISignup() {
  const toast = useToast();
  const { t } = useLocale();
  const {
    tasks,
    selectedTaskIds,
    allSelected,
    batchStartIds,
    batchStopIds,
    batchDeleteIds,
    canStartTask,
    canStopTask,
    canDeleteTask,
    loadTaskList,
    controlTask,
    deleteTask,
    runBatch,
    toggleAll,
    toggleOne,
  } = useSignupTasks({
    t,
    toast,
  });

  return (
    <div className="flex flex-col gap-4">
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={batchStartIds.length === 0}
            onClick={() => void runBatch("start")}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("common.start")} ({batchStartIds.length})
          </button>
          <button
            type="button"
            disabled={batchStopIds.length === 0}
            onClick={() => void runBatch("stop")}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("common.stop")} ({batchStopIds.length})
          </button>
          <button
            type="button"
            disabled={batchDeleteIds.length === 0}
            onClick={() => void runBatch("delete")}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("common.delete")} ({batchDeleteIds.length})
          </button>
          <button
            type="button"
            onClick={() => void loadTaskList().catch(() => undefined)}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t("common.refresh")}
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-245">
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="px-3 py-2">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    aria-label="Select all tasks"
                  />
                </TableHead>
                <TableHead className="px-3 py-2">{t("signup.taskId")}</TableHead>
                <TableHead className="px-3 py-2">{t("common.status")}</TableHead>
                <TableHead className="px-3 py-2">{t("signup.saved")}</TableHead>
                <TableHead className="px-3 py-2">{t("signup.count")}</TableHead>
                <TableHead className="px-3 py-2">{t("signup.concurrency")}</TableHead>
                <TableHead className="px-3 py-2">{t("signup.startTime")}</TableHead>
                <TableHead className="px-3 py-2">{t("signup.duration")}</TableHead>
                <TableHead className="px-3 py-2 text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="px-3 py-3 text-muted-foreground"
                    colSpan={9}
                  >
                    {t("signup.noTasks")}
                  </TableCell>
                </TableRow>
              ) : (
                tasks.map((task) => {
                  return (
                    <SignupTaskRow
                      key={task.id}
                      task={task}
                      checked={selectedTaskIds.includes(task.id)}
                      canStart={canStartTask(task)}
                      canStop={canStopTask(task)}
                      canDelete={canDeleteTask(task)}
                      t={t}
                      onCheckedChange={(checked) => toggleOne(task.id, checked)}
                      onStart={() => void controlTask(task.id, "start")}
                      onStop={() => void controlTask(task.id, "stop")}
                      onDelete={() => void deleteTask(task.id)}
                    />
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
