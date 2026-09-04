#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const colors = process.stdout.isTTY
  ? {
      blue: "\u001b[34m",
      green: "\u001b[32m",
      yellow: "\u001b[33m",
      bold: "\u001b[1m",
      reset: "\u001b[0m",
    }
  : { blue: "", green: "", yellow: "", bold: "", reset: "" };

function usage() {
  console.log(`Usage:
  node scripts/migrate-codex-session-provider.mjs [options]

Options:
  --to-openai          Change historical session providers to OpenAI
  --restore            Change historical session providers back to openai
  --status             Show provider statistics without changing data
  --codex-home PATH    Use a directory other than $CODEX_HOME or ~/.codex
  --yes                Skip the final interactive confirmation
  -h, --help           Show this help`);
}

function fail(message) {
  throw new Error(message);
}

function stage(index, total, title) {
  console.log(
    `\n${colors.bold}${colors.blue}Stage ${index}/${total} · ${title}${colors.reset}`,
  );
}

function info(message) {
  console.log(`  ${message}`);
}

function success(message) {
  console.log(`  ${colors.green}✓${colors.reset} ${message}`);
}

function warn(message) {
  console.warn(`  ${colors.yellow}⚠ ${message}${colors.reset}`);
}

function setMode(options, mode) {
  if (options.mode && options.mode !== mode) {
    fail("Choose only one of --to-openai, --restore, or --status");
  }
  options.mode = mode;
}

function parseArguments(argv) {
  const options = {
    mode: null,
    assumeYes: false,
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--to-openai") {
      setMode(options, "migrate");
    } else if (argument === "--restore") {
      setMode(options, "restore");
    } else if (argument === "--status") {
      setMode(options, "status");
    } else if (argument === "--yes") {
      options.assumeYes = true;
    } else if (argument === "--codex-home") {
      index += 1;
      if (!argv[index]) fail("Missing value for --codex-home");
      options.codexHome = argv[index];
    } else if (argument === "-h" || argument === "--help") {
      usage();
      process.exit(0);
    } else {
      fail(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    fail(`Node.js 22.5 or newer is required; found ${process.versions.node}`);
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function collectSessionFiles(codexHome) {
  const files = [];
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const directory = path.join(codexHome, directoryName);
    try {
      for await (const file of walkFiles(directory)) {
        if (file.endsWith(".jsonl")) files.push(file);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.sort();
}

async function collectStateDatabases(codexHome) {
  const entries = await readdir(codexHome, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name),
    )
    .map((entry) => path.join(codexHome, entry.name))
    .sort();
}

async function* readLinesWithEndings(file) {
  const stream = createReadStream(file, { encoding: "utf8" });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex + 1);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer) yield buffer;
}

function splitLineEnding(line) {
  if (line.endsWith("\r\n")) return [line.slice(0, -2), "\r\n"];
  if (line.endsWith("\n")) return [line.slice(0, -1), "\n"];
  return [line, ""];
}

function providerFields(item) {
  const fields = [];
  const payload = item && typeof item === "object" ? item.payload : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return fields;
  }
  if (typeof payload.model_provider === "string") {
    fields.push({
      path: "payload.model_provider",
      value: payload.model_provider,
      set(value) {
        payload.model_provider = value;
      },
    });
  }
  const settings = payload.thread_settings;
  if (
    settings &&
    typeof settings === "object" &&
    !Array.isArray(settings) &&
    typeof settings.model_provider_id === "string"
  ) {
    fields.push({
      path: "payload.thread_settings.model_provider_id",
      value: settings.model_provider_id,
      set(value) {
        settings.model_provider_id = value;
      },
    });
  }
  return fields;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

async function inspectSessionFiles(files) {
  const providers = new Map();
  const fields = new Map();
  for (const file of files) {
    let lineNumber = 0;
    for await (const line of readLinesWithEndings(file)) {
      lineNumber += 1;
      if (
        !line.includes('"model_provider"') &&
        !line.includes('"model_provider_id"')
      ) {
        continue;
      }
      const [content] = splitLineEnding(line);
      let item;
      try {
        item = JSON.parse(content);
      } catch (error) {
        fail(`Invalid JSONL at ${file}:${lineNumber}: ${error.message}`);
      }
      for (const field of providerFields(item)) {
        increment(fields, field.path);
        increment(providers, field.value);
      }
    }
  }
  return { providers, fields };
}

async function openDatabase(file, options) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    fail("This Node.js build does not provide the built-in node:sqlite module");
  }
  return new sqlite.DatabaseSync(file, options);
}

function databaseHasProviderColumn(database) {
  const table = database
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
    )
    .get();
  if (!table) return false;
  return database
    .prepare("PRAGMA table_info(threads)")
    .all()
    .some((column) => column.name === "model_provider");
}

async function inspectStateDatabases(files) {
  const providers = new Map();
  const applicableFiles = [];
  for (const file of files) {
    const database = await openDatabase(file, { readOnly: true });
    try {
      if (!databaseHasProviderColumn(database)) continue;
      applicableFiles.push(file);
      for (const row of database
        .prepare(
          "SELECT model_provider, COUNT(*) AS count FROM threads GROUP BY model_provider",
        )
        .all()) {
        increment(providers, String(row.model_provider), Number(row.count));
      }
    } finally {
      database.close();
    }
  }
  return { providers, applicableFiles };
}

async function inspect(codexHome) {
  const sessionFiles = await collectSessionFiles(codexHome);
  const stateDatabases = await collectStateDatabases(codexHome);
  const sessions = await inspectSessionFiles(sessionFiles);
  const databases = await inspectStateDatabases(stateDatabases);
  return { sessionFiles, stateDatabases, sessions, databases };
}

function sortedEntries(map) {
  return [...map.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function printSummary(snapshot) {
  info(`Session files: ${snapshot.sessionFiles.length}`);
  for (const [field, count] of sortedEntries(snapshot.sessions.fields)) {
    info(`${field}: ${count}`);
  }
  info("JSONL provider values:");
  if (snapshot.sessions.providers.size === 0) info("  (none)");
  for (const [provider, count] of sortedEntries(snapshot.sessions.providers)) {
    info(`  ${provider}: ${count}`);
  }
  info(`State databases: ${snapshot.databases.applicableFiles.length}`);
  info("Database thread providers:");
  if (snapshot.databases.providers.size === 0) info("  (none)");
  for (const [provider, count] of sortedEntries(snapshot.databases.providers)) {
    info(`  ${provider}: ${count}`);
  }
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function copyPreservingPath(source, codexHome, backupDataDirectory) {
  const relative = path.relative(codexHome, source);
  const destination = path.join(backupDataDirectory, relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
}

async function createBackup(codexHome, snapshot, targetProvider) {
  const backupDirectory = path.join(
    codexHome,
    "backups",
    `session-provider-${timestamp()}-${randomUUID().slice(0, 8)}`,
  );
  const dataDirectory = path.join(backupDirectory, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    await chmod(backupDirectory, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }

  for (const file of snapshot.sessionFiles) {
    await copyPreservingPath(file, codexHome, dataDirectory);
  }

  const stateFiles = await readdir(codexHome, { withFileTypes: true });
  for (const entry of stateFiles) {
    if (
      entry.isFile() &&
      /^state_\d+\.sqlite(?:-wal|-shm)?$/.test(entry.name)
    ) {
      await copyPreservingPath(
        path.join(codexHome, entry.name),
        codexHome,
        dataDirectory,
      );
    }
  }

  await writeFile(
    path.join(backupDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        codexHome,
        targetProvider,
        sessionFiles: snapshot.sessionFiles.length,
        stateDatabases: snapshot.databases.applicableFiles.length,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return backupDirectory;
}

async function rewriteSessionFile(file, targetProvider) {
  const sourceStat = await stat(file);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const destination = await open(temporary, "wx", sourceStat.mode);
  let fieldsChanged = 0;
  let lineNumber = 0;
  let writeError = null;
  try {
    for await (const line of readLinesWithEndings(file)) {
      lineNumber += 1;
      let output = line;
      if (
        line.includes('"model_provider"') ||
        line.includes('"model_provider_id"')
      ) {
        const [content, ending] = splitLineEnding(line);
        let item;
        try {
          item = JSON.parse(content);
        } catch (error) {
          fail(`Invalid JSONL at ${file}:${lineNumber}: ${error.message}`);
        }
        let lineChanged = false;
        for (const field of providerFields(item)) {
          if (field.value !== targetProvider) {
            field.set(targetProvider);
            fieldsChanged += 1;
            lineChanged = true;
          }
        }
        if (lineChanged) output = `${JSON.stringify(item)}${ending}`;
      }
      await destination.write(output);
    }
    await destination.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await destination.close();
  }
  if (writeError) {
    await rm(temporary, { force: true });
    throw writeError;
  }

  if (fieldsChanged === 0) {
    await rm(temporary, { force: true });
    return 0;
  }

  try {
    try {
      await chmod(temporary, sourceStat.mode);
      await utimes(temporary, sourceStat.atime, sourceStat.mtime);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return fieldsChanged;
}

async function rewriteSessionFiles(files, targetProvider) {
  let filesChanged = 0;
  let fieldsChanged = 0;
  for (const file of files) {
    const changed = await rewriteSessionFile(file, targetProvider);
    if (changed > 0) filesChanged += 1;
    fieldsChanged += changed;
  }
  return { filesChanged, fieldsChanged };
}

async function updateStateDatabases(files, targetProvider) {
  let filesChanged = 0;
  let rowsChanged = 0;
  for (const file of files) {
    const database = await openDatabase(file);
    try {
      if (!databaseHasProviderColumn(database)) continue;
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database
          .prepare(
            "UPDATE threads SET model_provider = ? WHERE model_provider <> ?",
          )
          .run(targetProvider, targetProvider);
        database.exec("COMMIT");
        const changed = Number(result.changes);
        if (changed > 0) filesChanged += 1;
        rowsChanged += changed;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }
  return { filesChanged, rowsChanged };
}

async function assertWritable(snapshot) {
  for (const file of [
    ...snapshot.sessionFiles,
    ...snapshot.databases.applicableFiles,
  ]) {
    await access(file, fsConstants.R_OK | fsConstants.W_OK);
  }
}

async function chooseMode(terminal) {
  console.log("  1) Migrate historical sessions to OpenAI");
  console.log("  2) Restore historical sessions to openai");
  console.log("  3) Show status only");
  console.log("  4) Exit");
  const selection = (await terminal.question("  Select [1-4]: ")).trim();
  if (selection === "1") return "migrate";
  if (selection === "2") return "restore";
  if (selection === "3") return "status";
  if (selection === "4") return "exit";
  fail("Invalid selection");
}

async function confirmMigration(terminal, targetProvider) {
  warn("Close every Codex CLI, desktop app, and IDE extension before continuing.");
  warn("Running Codex processes can append or overwrite history during migration.");
  const answer = await terminal.question(
    `  Type ${targetProvider} to confirm the migration: `,
  );
  return answer.trim() === targetProvider;
}

function verifyTarget(snapshot, targetProvider) {
  const unexpected = [
    ...snapshot.sessions.providers.keys(),
    ...snapshot.databases.providers.keys(),
  ].filter((provider) => provider !== targetProvider);
  if (unexpected.length > 0) {
    fail(`Verification found unexpected providers: ${[...new Set(unexpected)].join(", ")}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertSupportedNode();
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let lockDirectory = null;

  try {
    console.log(
      `\n${colors.bold}Codex historical session provider migration${colors.reset}`,
    );
    stage(1, 4, "Environment check");
    const codexHome = path.resolve(options.codexHome);
    await access(codexHome, fsConstants.R_OK | fsConstants.W_OK);
    info(`Codex data directory: ${codexHome}`);
    const before = await inspect(codexHome);
    await assertWritable(before);
    printSummary(before);

    stage(2, 4, "Choose target provider");
    const mode = options.mode || (await chooseMode(terminal));
    if (mode === "exit") return;
    if (mode === "status") {
      success("Status inspection complete; no files were changed");
      return;
    }
    const targetProvider = mode === "migrate" ? "OpenAI" : "openai";
    info(`Target provider: ${targetProvider}`);

    if (targetProvider === "OpenAI") {
      const configPath = path.join(codexHome, "config.toml");
      const config = await readFile(configPath, "utf8").catch(() => "");
      if (
        !/^\s*\[model_providers\.(?:OpenAI|["']OpenAI["'])\]\s*$/m.test(
          config,
        )
      ) {
        warn(`No [model_providers.OpenAI] entry was found in ${configPath}`);
      }
    }

    stage(3, 4, "Safety confirmation");
    info("Only historical provider fields are changed; config.toml is untouched.");
    info("A private backup is created before any mutation.");
    if (!options.assumeYes) {
      const confirmed = await confirmMigration(terminal, targetProvider);
      if (!confirmed) {
        info("Cancelled; nothing was changed.");
        return;
      }
    } else {
      warn("--yes skips confirmation; make sure all Codex processes are closed.");
    }

    stage(4, 4, "Backup, migrate, and verify");
    lockDirectory = path.join(codexHome, ".session-provider-migration.lock");
    try {
      await mkdir(lockDirectory);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`Another migration appears to be running: ${lockDirectory}`);
      }
      throw error;
    }

    const backupDirectory = await createBackup(
      codexHome,
      before,
      targetProvider,
    );
    success(`Backup created: ${backupDirectory}`);
    const sessionResult = await rewriteSessionFiles(
      before.sessionFiles,
      targetProvider,
    );
    const databaseResult = await updateStateDatabases(
      before.databases.applicableFiles,
      targetProvider,
    );
    info(`JSONL files changed: ${sessionResult.filesChanged}`);
    info(`JSONL provider fields changed: ${sessionResult.fieldsChanged}`);
    info(`State databases changed: ${databaseResult.filesChanged}`);
    info(`Database thread rows changed: ${databaseResult.rowsChanged}`);

    const after = await inspect(codexHome);
    verifyTarget(after, targetProvider);
    printSummary(after);
    success(`Historical sessions now target ${targetProvider}`);
    info("Restart Codex before resuming an existing session.");
  } finally {
    terminal.close();
    if (lockDirectory) await rm(lockDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n${colors.yellow}Migration failed:${colors.reset} ${error.message}`);
  process.exitCode = 1;
});
