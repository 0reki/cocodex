"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocaleKey } from "@/locales";
import type {
  SignupTask,
  SignupTaskAction,
  SignupTaskListResponse,
} from "@/lib/features/signup/types/signup-task-types";
import { isTerminalStatus } from "@/lib/features/signup/utils/signup-task-utils";

export function useSignupTasks(props: {
  t: (key: LocaleKey) => string;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
  };
}) {
  const { t, toast } = props;
  const [tasks, setTasks] = useState<SignupTask[]>([]);
  const [actingTaskIds, setActingTaskIds] = useState<Record<string, boolean>>({});
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

  const hasRunningTasks = useMemo(
    () => tasks.some((task) => !isTerminalStatus(task.status)),
    [tasks],
  );

  const setTaskActing = (taskId: string, acting: boolean) => {
    setActingTaskIds((prev) => {
      if (acting) return { ...prev, [taskId]: true };
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  const setManyTasksActing = (taskIds: string[], acting: boolean) => {
    setActingTaskIds((prev) => {
      const next = { ...prev };
      for (const taskId of taskIds) {
        if (acting) next[taskId] = true;
        else delete next[taskId];
      }
      return next;
    });
  };

  const loadTaskList = useCallback(async () => {
    const res = await fetch("/api/debug/openai-signup?limit=100", {
      method: "GET",
      cache: "no-store",
    });
    const data = (await res.json()) as SignupTaskListResponse;
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    setTasks(Array.isArray(data.tasks) ? data.tasks : []);
  }, []);

  useEffect(() => {
    void loadTaskList().catch(() => undefined);
  }, [loadTaskList]);

  useEffect(() => {
    if (!hasRunningTasks) return;
    const timer = setInterval(() => {
      void loadTaskList().catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [hasRunningTasks, loadTaskList]);

  useEffect(() => {
    const visible = new Set(tasks.map((item) => item.id));
    setSelectedTaskIds((prev) => prev.filter((id) => visible.has(id)));
  }, [tasks]);

  const canStartTask = (task: SignupTask) =>
    !actingTaskIds[task.id] &&
    (task.status === "pending" || task.status === "stopped" || task.status === "failed");
  const canStopTask = (task: SignupTask) =>
    !actingTaskIds[task.id] && (task.status === "pending" || task.status === "running");
  const canDeleteTask = (task: SignupTask) => !actingTaskIds[task.id];

  const selectedTasks = useMemo(
    () => tasks.filter((task) => selectedTaskIds.includes(task.id)),
    [tasks, selectedTaskIds],
  );
  const selectableIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const allSelected =
    selectableIds.length > 0 && selectedTaskIds.length === selectableIds.length;
  const batchStartIds = useMemo(
    () => selectedTasks.filter(canStartTask).map((task) => task.id),
    [selectedTasks, actingTaskIds],
  );
  const batchStopIds = useMemo(
    () => selectedTasks.filter(canStopTask).map((task) => task.id),
    [selectedTasks, actingTaskIds],
  );
  const batchDeleteIds = useMemo(
    () => selectedTasks.filter(canDeleteTask).map((task) => task.id),
    [selectedTasks, actingTaskIds],
  );

  const controlTask = async (
    taskId: string,
    action: Extract<SignupTaskAction, "start" | "stop">,
    options?: { silent?: boolean; refresh?: boolean },
  ) => {
    const silent = options?.silent ?? false;
    const refresh = options?.refresh ?? true;
    setTaskActing(taskId, true);
    try {
      const res = await fetch(`/api/debug/openai-signup/${encodeURIComponent(taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        cache: "no-store",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (refresh) {
        await loadTaskList();
      }
      if (!silent) {
        toast.success(
          action === "start" ? t("signup.taskStarted") : t("signup.taskStopping"),
        );
      }
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      setTaskActing(taskId, false);
    }
  };

  const deleteTask = async (
    taskId: string,
    options?: { silent?: boolean; refresh?: boolean },
  ) => {
    const silent = options?.silent ?? false;
    const refresh = options?.refresh ?? true;
    setTaskActing(taskId, true);
    try {
      const res = await fetch(`/api/debug/openai-signup/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (refresh) {
        await loadTaskList();
      }
      if (!silent) {
        toast.success(t("signup.taskDeleted"));
      }
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      setTaskActing(taskId, false);
    }
  };

  const runBatch = async (action: SignupTaskAction) => {
    const ids =
      action === "start"
        ? batchStartIds
        : action === "stop"
          ? batchStopIds
          : batchDeleteIds;
    if (ids.length === 0) return;
    setManyTasksActing(ids, true);
    let success = 0;
    try {
      for (const taskId of ids) {
        try {
          if (action === "delete") {
            await deleteTask(taskId, { silent: true, refresh: false });
          } else {
            await controlTask(taskId, action, { silent: true, refresh: false });
          }
          success += 1;
        } catch {
          // Keep processing remaining tasks and report aggregate result.
        }
      }
      await loadTaskList();
      setSelectedTaskIds((prev) => prev.filter((id) => !ids.includes(id)));
      toast.success(
        `${action === "start" ? t("common.start") : action === "stop" ? t("common.stop") : t("common.delete")}: ${success}/${ids.length}`,
      );
    } finally {
      setManyTasksActing(ids, false);
    }
  };

  return {
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
    toggleAll: (checked: boolean) => {
      setSelectedTaskIds(checked ? selectableIds : []);
    },
    toggleOne: (taskId: string, checked: boolean) => {
      setSelectedTaskIds((prev) => {
        if (checked) return [...new Set([...prev, taskId])];
        return prev.filter((id) => id !== taskId);
      });
    },
  };
}
