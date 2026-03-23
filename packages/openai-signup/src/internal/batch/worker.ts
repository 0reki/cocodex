import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { runSingleFlow } from "../shared/flow.ts";
import type { MainToWorkerMessage, WorkerToMainMessage } from "../shared/types.ts";

export async function runWorkerThread() {
  if (!parentPort) {
    throw new Error("worker thread missing parentPort");
  }

  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandledRejection:", reason);
  });

  const total =
    typeof workerData?.total === "number" && Number.isFinite(workerData.total)
      ? workerData.total
      : 1;

  parentPort.on("message", (msg: MainToWorkerMessage) => {
    void (async () => {
      if (msg.type === "stop") {
        process.exit(0);
        return;
      }
      if (msg.type !== "run" || !msg.runId) return;

      try {
        const result = await runSingleFlow(
          msg.runId,
          total,
          false,
          msg.proxyUrl,
          Array.isArray(msg.proxyPool) ? msg.proxyPool : [],
        );
        parentPort!.postMessage({
          type: "result",
          result,
        } satisfies WorkerToMainMessage);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        parentPort!.postMessage({
          type: "result",
          result: {
            runId: msg.runId,
            ok: false,
            email: "<unknown>",
            durationMs: 0,
            attempts: 0,
            error: err.message,
          },
        } satisfies WorkerToMainMessage);
      } finally {
        parentPort!.postMessage({
          type: "ready",
        } satisfies WorkerToMainMessage);
      }
    })().catch((error) => {
      console.error("Worker message handler fatal error:", error);
    });
  });

  parentPort.postMessage({ type: "ready" } satisfies WorkerToMainMessage);
}

export async function runSignupWorkerThread() {
  return runWorkerThread();
}

export function startSignupWorkerThreadIfNeeded() {
  if (!isMainThread) {
    runWorkerThread().catch((e) => {
      console.error("\x1b[31mWorker fatal error:\x1b[0m", e);
      process.exit(1);
    });
  }
}
