import { fromBase64Url } from "../shared/runtime.ts";
import type {
  AccountsCheckResponse,
  AccountsCheckWorkspace,
  CookieJarLike,
  Workspace,
} from "../shared/types.ts";

export function listCookieNames(cookieString: string): string[] {
  if (!cookieString) return [];
  return cookieString
    .split(";")
    .map((item: string) => item.trim())
    .map((item: string) => item.split("=")[0] ?? "")
    .filter(Boolean);
}

export async function seedCookiesFromHeader(
  jar: CookieJarLike,
  cookieHeader: string,
  url: string,
): Promise<void> {
  const raw = cookieHeader.trim();
  if (!raw) return;
  const parts = raw.split(";");
  for (const part of parts) {
    const item = part.trim();
    if (!item) continue;
    const eqIndex = item.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = item.slice(0, eqIndex).trim();
    const value = item.slice(eqIndex + 1).trim();
    if (!name) continue;
    await jar.setCookie(`${name}=${value}; Path=/; Secure`, url);
  }
}

export async function getCookieValue(
  jar: CookieJarLike,
  url: string,
  name: string,
): Promise<string | null> {
  const cookieString = await jar.getCookieString(url);
  if (!cookieString) return null;
  for (const item of cookieString.split(";")) {
    const pair = item.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1);
    if (k === name) return v;
  }
  return null;
}

export async function updateCookies(
  jar: CookieJarLike,
  setCookie: string[] | string | null,
  currentUrl: string,
) {
  if (!setCookie) return;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of cookies) {
    try {
      await jar.setCookie(line, currentUrl);
    } catch {
      // ignore malformed cookie lines
    }
  }
}

export function mapAccountsCheckPayloadToWorkspaces(
  payload: AccountsCheckResponse,
): AccountsCheckWorkspace[] {
  const accounts = payload.accounts;
  if (!accounts || typeof accounts !== "object") return [];

  const result: AccountsCheckWorkspace[] = [];
  for (const [key, node] of Object.entries(accounts)) {
    if (key === "default") continue;
    const accountId =
      typeof node?.account?.account_id === "string" &&
      node.account.account_id.trim()
        ? node.account.account_id.trim()
        : null;
    const workspaceId = accountId ?? key;
    if (!workspaceId) continue;
    result.push({
      workspaceId,
      workspaceName:
        typeof node?.account?.name === "string" ? node.account.name : null,
      planType:
        typeof node?.account?.plan_type === "string"
          ? node.account.plan_type
          : null,
      expiresAt:
        typeof node?.entitlement?.expires_at === "string"
          ? node.entitlement.expires_at
          : null,
    });
  }

  return result;
}

export function selectPreferredWorkspaceId(
  workspaces: AccountsCheckWorkspace[],
): string | null {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null;

  const parseTs = (value: string | null): number => {
    if (!value) return Number.NEGATIVE_INFINITY;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
  };

  const teams = workspaces.filter((w) => w.planType === "team");
  if (teams.length > 0) {
    const chosen = [...teams].sort(
      (a, b) => parseTs(b.expiresAt) - parseTs(a.expiresAt),
    )[0];
    return chosen?.workspaceId ?? null;
  }

  const free = workspaces.find((w) => w.planType === "free");
  if (free?.workspaceId) return free.workspaceId;
  return workspaces[0]?.workspaceId ?? null;
}

export function extractWorkspacesFromAuthSessionCookieValue(
  cookieString: string,
): Workspace[] {
  const target = cookieString
    .split(";")
    .map((item: string) => item.trim())
    .find((item: string) => item.startsWith("oai-client-auth-session="));

  if (!target) return [];

  const raw = target.slice("oai-client-auth-session=".length);
  const payloadPart = raw.split(".")[0] ?? "";
  if (!payloadPart) return [];

  let decoded = "";
  try {
    decoded = fromBase64Url(payloadPart);
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(decoded) as { workspaces?: Workspace[] };
    return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
  } catch {
    return [];
  }
}
