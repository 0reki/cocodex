import { query } from "../../core/db.ts";
import {
  mapOpenAIAccountRow,
  OPENAI_ACCOUNT_COLUMNS,
  type OpenAIAccountRow,
} from "./shared.ts";

export async function getActiveOpenAIAccount() {
  const result = await query<OpenAIAccountRow>(
    `
      SELECT ${OPENAI_ACCOUNT_COLUMNS}
      FROM openai_accounts
      WHERE LOWER(TRIM(status)) = 'active'
        AND access_token IS NOT NULL
        AND BTRIM(access_token) <> ''
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  );
  const row = result.rows[0];
  return row ? mapOpenAIAccountRow(row) : null;
}

/**
 * Resolves the active upstream account for a client platform.
 *
 * Preference order:
 * 1. An account tagged with the exact platform (`windows` / `linux` / `darwin`).
 * 2. A generic account tagged `all` (fallback).
 */
export async function getActiveOpenAIAccountByPlatform(platform: string) {
  const normalized = platform.trim().toLowerCase();
  if (!normalized) return null;

  const result = await query<OpenAIAccountRow>(
    `
      SELECT ${OPENAI_ACCOUNT_COLUMNS}
      FROM openai_accounts
      WHERE LOWER(TRIM(status)) = 'active'
        AND access_token IS NOT NULL
        AND BTRIM(access_token) <> ''
        AND LOWER(TRIM(COALESCE(platform, 'all'))) = ANY($1)
      ORDER BY
        CASE WHEN LOWER(TRIM(COALESCE(platform, 'all'))) = $2 THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `,
    [[normalized, "all"], normalized],
  );
  const row = result.rows[0];
  return row ? mapOpenAIAccountRow(row) : null;
}
