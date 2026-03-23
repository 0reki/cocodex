import fs from "node:fs";
import path from "node:path";

function loadEnvFile(filePath, overwrite = false) {
  if (!fs.existsSync(filePath)) return;
  const source = fs.readFileSync(filePath, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    if (!overwrite && process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadWebEnv() {
  const cwd = process.cwd();
  const workspaceRoot = fs.existsSync(path.join(cwd, "apps", "web"))
    ? cwd
    : path.basename(cwd) === "web" &&
        path.basename(path.dirname(cwd)) === "apps"
      ? path.resolve(cwd, "..", "..")
      : cwd;
  const webDir = path.join(workspaceRoot, "apps", "web");

  // 1) workspace root defaults
  loadEnvFile(path.join(workspaceRoot, ".env.local"), false);
  loadEnvFile(path.join(workspaceRoot, ".env"), false);
  // 2) web-specific overrides
  loadEnvFile(path.join(webDir, ".env.local"), true);
  loadEnvFile(path.join(webDir, ".env"), true);
  // 3) current working directory overrides (if different)
  loadEnvFile(path.join(cwd, ".env.local"), true);
  loadEnvFile(path.join(cwd, ".env"), true);
}

loadWebEnv();

const allowedDevOrigins = (
  process.env.ALLOWED_DEV_ORIGINS ?? "https://test.antihub.org"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: [
    "@workspace/ui",
    "@workspace/database",
    "@workspace/openai-api",
    "@workspace/openai-codex-auth",
  ],
  allowedDevOrigins,
};

export default nextConfig;
