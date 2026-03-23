import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function generateApiKeyValue() {
  return `sk-${crypto.randomBytes(24).toString("base64url")}`;
}

export function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadBackendEnv() {
  const cwd = process.cwd();
  const workspaceRoot = fs.existsSync(path.join(cwd, "apps", "backend"))
    ? cwd
    : path.basename(cwd) === "backend" &&
        path.basename(path.dirname(cwd)) === "apps"
      ? path.resolve(cwd, "..", "..")
      : cwd;
  const backendDir = path.join(workspaceRoot, "apps", "backend");

  loadEnvFile(path.join(workspaceRoot, ".env.local"));
  loadEnvFile(path.join(workspaceRoot, ".env"));
  loadEnvFile(path.join(backendDir, ".env.local"));
  loadEnvFile(path.join(backendDir, ".env"));
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
}
