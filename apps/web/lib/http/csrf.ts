import { randomBytes, timingSafeEqual } from "node:crypto";

export function createCsrfToken() {
  return randomBytes(32).toString("hex");
}

export function safeEqualToken(a: string, b: string) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
