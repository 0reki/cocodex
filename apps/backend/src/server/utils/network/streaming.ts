import type { Request, Response } from "express";
import zlib from "node:zlib";

export function createSseHeartbeatController(args: {
  res: Response;
  defaultIntervalMs?: number;
  defaultMaxConsecutive?: number;
  intervalMs?: number;
  maxConsecutive?: number;
  continuous?: boolean;
  onHeartbeat?: () => void;
}) {
  const intervalMs =
    typeof args.intervalMs === "number" && Number.isFinite(args.intervalMs)
      ? Math.max(1_000, Math.floor(args.intervalMs))
      : (args.defaultIntervalMs ?? 30_000);
  const maxConsecutive =
    typeof args.maxConsecutive === "number" &&
      Number.isFinite(args.maxConsecutive)
      ? Math.max(1, Math.floor(args.maxConsecutive))
      : (args.defaultMaxConsecutive ?? 6);
  const continuous = args.continuous === true;

  let lastActivityAt = Date.now();
  let lastHeartbeatAt = 0;
  let consecutiveHeartbeats = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const markActivity = () => {
    lastActivityAt = Date.now();
    lastHeartbeatAt = 0;
    consecutiveHeartbeats = 0;
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(() => {
    if (args.res.writableEnded || args.res.destroyed) {
      stop();
      return;
    }
    const now = Date.now();
    if (now - lastActivityAt < intervalMs) return;
    if (!continuous && consecutiveHeartbeats >= maxConsecutive) {
      if (lastHeartbeatAt > 0 && now - lastHeartbeatAt < intervalMs * 2) return;
      consecutiveHeartbeats = 0;
    }
    if (lastHeartbeatAt > 0 && now - lastHeartbeatAt < intervalMs) return;
    args.res.write(`: heartbeat ${now}\n\n`);
    args.onHeartbeat?.();
    lastHeartbeatAt = now;
    consecutiveHeartbeats += 1;
  }, intervalMs);

  return { markActivity, stop };
}

export function parseContentEncodingHeader(value: string | string[] | undefined) {
  if (!value) return [];
  const merged = Array.isArray(value) ? value.join(",") : value;
  return merged
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export async function readRequestBodyBuffer(
  req: Request,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        cleanup();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });

  return Buffer.concat(chunks);
}

export function zstdDecompressBuffer(buffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zlib.zstdDecompress(buffer, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.isBuffer(result) ? result : Buffer.from(result));
    });
  });
}
