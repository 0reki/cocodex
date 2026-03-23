export type SignupTaskStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export type SignupTask = {
  id: string;
  status: SignupTaskStatus;
  count: number;
  concurrency: number;
  cpuMaxConcurrency: number;
  proxyPoolSize: number;
  savedCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  result: unknown;
};

export type SignupTaskListResponse = {
  ok: boolean;
  tasks?: SignupTask[];
  error?: string;
};

export type SignupTaskAction = "start" | "stop" | "delete";
