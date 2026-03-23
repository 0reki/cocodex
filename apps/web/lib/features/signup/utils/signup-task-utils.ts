import type { SignupTaskStatus } from "../types/signup-task-types";

export function getTaskStatusBadgeVariant(
  status: SignupTaskStatus,
): "secondary" | "outline" | "default" | "destructive" {
  if (status === "completed") return "secondary";
  if (status === "failed") return "destructive";
  if (status === "running") return "default";
  if (status === "stopping") return "outline";
  return "outline";
}

export function isTerminalStatus(status: SignupTaskStatus) {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const ms = Math.max(0, Math.floor(value));
  if (ms < 1000) return `${ms} ms`;

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} m ${seconds} s` : `${minutes} m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours} h ${remainMinutes} m` : `${hours} h`;
}

export function formatLocalDateTime(value: string | null): string {
  if (!value) return "-";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}
