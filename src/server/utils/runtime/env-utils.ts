import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type PersistedSetupConfig = {
  version: 1;
  databaseUrl: string;
  adminJwtSecret: string;
  configuredAt: string;
};

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
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
  loadPersistedSetupConfig();
}

export function getSetupConfigPath() {
  const configured = process.env.COCODEX_CONFIG_PATH?.trim();
  return path.resolve(configured || path.join(process.cwd(), "data", "config.json"));
}

function isPersistedSetupConfig(value: unknown): value is PersistedSetupConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<PersistedSetupConfig>;
  return (
    config.version === 1 &&
    typeof config.databaseUrl === "string" &&
    Boolean(config.databaseUrl.trim()) &&
    typeof config.adminJwtSecret === "string" &&
    Boolean(config.adminJwtSecret.trim()) &&
    typeof config.configuredAt === "string"
  );
}

export function loadPersistedSetupConfig() {
  const configPath = getSetupConfigPath();
  if (!fs.existsSync(configPath)) return false;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!isPersistedSetupConfig(parsed)) {
      throw new Error("invalid setup configuration format");
    }
    if (!process.env.DATABASE_URL?.trim()) {
      process.env.DATABASE_URL = parsed.databaseUrl.trim();
    }
    if (!process.env.ADMIN_JWT_SECRET?.trim()) {
      process.env.ADMIN_JWT_SECRET = parsed.adminJwtSecret.trim();
    }
    return true;
  } catch (error) {
    console.error(
      `[setup] failed to load ${configPath}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export function persistSetupConfig(input: {
  databaseUrl: string;
  adminJwtSecret: string;
}) {
  const configPath = getSetupConfigPath();
  const configDirectory = path.dirname(configPath);
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const config: PersistedSetupConfig = {
    version: 1,
    databaseUrl: input.databaseUrl,
    adminJwtSecret: input.adminJwtSecret,
    configuredAt: new Date().toISOString(),
  };

  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDirectory, 0o700);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup errors when the temporary file was never created.
    }
    throw error;
  }

  return configPath;
}
