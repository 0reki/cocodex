import { fetchJson } from "@/lib/api";

export type SetupStatus = {
  setupRequired: boolean;
  reason:
    | "missing_database"
    | "database_unreachable"
    | "admin_missing"
    | "missing_jwt_secret"
    | null;
  databaseConfigured: boolean;
  databaseReachable: boolean | null;
  adminConfigured: boolean | null;
};

export function getSetupStatus() {
  return fetchJson<SetupStatus>("/api/setup/status", { cache: "no-store" });
}

export function completeSetup(input: {
  databaseUrl?: string;
  adminUsername: string;
  adminPassword: string;
}) {
  return fetchJson<{ ok: true; redirectTo: string }>("/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
