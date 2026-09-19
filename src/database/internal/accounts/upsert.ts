import { withTransaction } from "../../core/db.ts";
import type { UpsertOpenAIAccountInput } from "../types.ts";
import {
  mapOpenAIAccountRow,
  normalizeOpenAIAccountPlatform,
  normalizeOpenAIAccountStatus,
  type OpenAIAccountRow,
} from "./shared.ts";

export async function upsertOpenAIAccount(input: UpsertOpenAIAccountInput) {
  return withTransaction(async (client) => {
    const email = input.email.trim().toLowerCase();
    const accountId = input.accountId.trim();
    const idToken = input.idToken.trim();
    const accessToken = input.accessToken.trim();
    const refreshToken = input.refreshToken.trim();
    if (!email || !accountId || !idToken || !accessToken || !refreshToken) {
      throw new Error(
        "email, accountId, idToken, accessToken and refreshToken are required",
      );
    }
    const requestedStatus = input.status?.trim() ?? "";
    const normalizedRequestedStatus = requestedStatus
      ? normalizeOpenAIAccountStatus(requestedStatus)
      : null;
    if (requestedStatus && !normalizedRequestedStatus) {
      throw new Error(`Invalid OpenAI account status: ${requestedStatus}`);
    }
    const requestedPlatform = input.platform?.trim() ?? "";
    const normalizedRequestedPlatform = requestedPlatform
      ? normalizeOpenAIAccountPlatform(requestedPlatform)
      : null;
    if (requestedPlatform && !normalizedRequestedPlatform) {
      throw new Error(`Invalid OpenAI account platform: ${requestedPlatform}`);
    }

    const existing = await client.query<{
      status: string | null;
      platform: string | null;
    }>(
      `SELECT status, platform FROM openai_accounts WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const platform =
      normalizedRequestedPlatform ??
      (existing.rows[0]
        ? (normalizeOpenAIAccountPlatform(existing.rows[0].platform ?? "") ??
          "all")
        : "all");

    let status = normalizedRequestedStatus;
    if (!status && existing.rows[0]) {
      status =
        normalizeOpenAIAccountStatus(existing.rows[0].status ?? "") ??
        "inactive";
    }
    if (!status) {
      const active = await client.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM openai_accounts
          WHERE LOWER(TRIM(status)) = 'active'
            AND LOWER(TRIM(COALESCE(platform, 'all'))) = LOWER($1)
        ) AS exists
      `,
        [platform],
      );
      status = active.rows[0]?.exists ? "inactive" : "active";
    }

    if (status === "active") {
      await client.query(
        `
          UPDATE openai_accounts
          SET status = 'inactive'
          WHERE LOWER(TRIM(status)) = 'active'
            AND email <> $1
            AND LOWER(TRIM(COALESCE(platform, 'all'))) = LOWER($2)
        `,
        [email, platform],
      );
    }

    const result = await client.query<OpenAIAccountRow>(
      `
        INSERT INTO openai_accounts (
          email, account_id, status, platform, id_token, access_token,
          refresh_token
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7
        )
        ON CONFLICT (email) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          status = EXCLUDED.status,
          platform = EXCLUDED.platform,
          id_token = EXCLUDED.id_token,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token
        RETURNING *
      `,
      [email, accountId, status, platform, idToken, accessToken, refreshToken],
    );

    const row = result.rows[0];
    if (!row) throw new Error("Failed to upsert OpenAI account");

    return mapOpenAIAccountRow(row);
  });
}
