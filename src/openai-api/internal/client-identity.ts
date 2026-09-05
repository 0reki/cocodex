import os from "node:os";

export const DEFAULT_CODEX_CLIENT_VERSION = "0.153.4";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const RETRY_INTERVAL_MS = 60 * 60 * 1_000;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function buildCodexUserAgent(version: string): string {
  const architectures: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
  const architecture = architectures[os.arch()] ?? os.arch();
  // A headless backend has no interactive terminal to report.
  return `codex_cli_rs/${version} (${os.type()} ${os.release()}; ${architecture}) unknown`.replace(
    /[^\x20-\x7e]/g,
    "_",
  );
}

export function createCodexVersionResolver(deps: {
  fetch: typeof globalThis.fetch;
  now: () => number;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
}) {
  let version = DEFAULT_CODEX_CLIENT_VERSION;
  let nextCheckAt = 0;
  let pending: Promise<void> | undefined;
  let etag: string | null = null;

  async function refresh() {
    nextCheckAt = deps.now() + RETRY_INTERVAL_MS;
    try {
      const headers = new Headers({
        Accept: "application/vnd.github+json",
        "User-Agent": buildCodexUserAgent(version),
        "X-GitHub-Api-Version": "2022-11-28",
      });
      const token = deps.env.CODEX_GITHUB_TOKEN?.trim();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (etag) headers.set("If-None-Match", etag);
      const response = await deps.fetch(
        "https://api.github.com/repos/openai/codex/releases/latest",
        { headers, signal: AbortSignal.timeout(5_000), redirect: "error" },
      );
      if (response.status === 304) {
        nextCheckAt = deps.now() + REFRESH_INTERVAL_MS;
        return;
      }
      if (!response.ok) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
        const retry = response.headers.get("retry-after");
        const retryAt = retry === null
          ? 0
          : /^\d+$/.test(retry)
            ? deps.now() + Number(retry) * 1_000
            : Date.parse(retry);
        if (response.status === 403 || response.status === 429) {
          nextCheckAt = Math.max(
            nextCheckAt,
            Number.isFinite(reset) ? reset : 0,
            Number.isFinite(retryAt) ? retryAt : 0,
          );
        }
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const release = (await response.json()) as {
        tag_name?: unknown;
        draft?: unknown;
        prerelease?: unknown;
      } | null;
      const candidate = typeof release?.tag_name === "string"
        ? release.tag_name.replace(/^rust-v/, "")
        : "";
      if (
        !STABLE_VERSION.test(candidate) ||
        release?.draft !== false ||
        release?.prerelease !== false
      ) {
        throw new Error("Invalid stable release metadata");
      }
      version = candidate;
      etag = response.headers.get("etag");
      nextCheckAt = deps.now() + REFRESH_INTERVAL_MS;
    } catch (error) {
      // Do not log response bodies, request headers, or potentially credential-bearing errors.
      const reason = error instanceof Error && /^HTTP \d+$/.test(error.message)
        ? error.message
        : "network error or invalid release metadata";
      deps.warn(`[codex-version] ${reason}; keeping ${version}`);
    }
  }

  function getVersion() {
    const pinned = deps.env.CODEX_CLIENT_VERSION?.trim();
    if (pinned && pinned !== "auto") {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned)) {
        throw new Error(
          "CODEX_CLIENT_VERSION must be auto or a Codex version number",
        );
      }
      return pinned;
    }
    // GitHub availability must never block an upstream request.
    if (!pending && deps.now() >= nextCheckAt) {
      pending = refresh().finally(() => {
        pending = undefined;
      });
    }
    return version;
  }

  return { getVersion };
}

const resolver = createCodexVersionResolver({
  fetch: (...args) => globalThis.fetch(...args),
  now: Date.now,
  env: process.env,
  warn: (message) => console.warn(message),
});

export const getCodexClientVersion = resolver.getVersion;

export function getCodexUserAgent() {
  return buildCodexUserAgent(getCodexClientVersion());
}
