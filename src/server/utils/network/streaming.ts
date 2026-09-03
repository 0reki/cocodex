import type { Request } from "express";
import zlib from "node:zlib";

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
        req.resume();
        reject(
          Object.assign(new Error("Request body too large"), { status: 413 }),
        );
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

export function zstdDecompressBuffer(
  buffer: Buffer,
  maxOutputLength: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zlib.zstdDecompress(
      buffer,
      { maxOutputLength },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(result) ? result : Buffer.from(result));
      },
    );
  });
}
