import { query } from "../core/db.ts";
import {
  mapOpenAIAccountRow,
  type OpenAIAccountRow,
} from "./accounts/shared.ts";
export async function listAssignedOpenAIAccounts() {
  const result = await query<OpenAIAccountRow & { owner_user_id: string }>(
    `
      SELECT
        assignments.owner_user_id,
        accounts.id, accounts.email, accounts.account_id, accounts.status,
        accounts.id_token, accounts.access_token, accounts.refresh_token,
        accounts.created_at, accounts.updated_at
      FROM portal_user_upstream_assignments AS assignments
      JOIN openai_accounts AS accounts
        ON accounts.id = assignments.source_account_id
    `,
  );
  return result.rows.map((row) => ({
    ownerUserId: row.owner_user_id,
    account: mapOpenAIAccountRow(row),
  }));
}

export async function listPortalUserUpstreamAssignments() {
  const result = await query<{
    owner_user_id: string;
    source_account_id: string;
  }>(
    `
      SELECT owner_user_id, source_account_id
      FROM portal_user_upstream_assignments
    `,
  );
  return result.rows.map((row) => ({
    ownerUserId: row.owner_user_id,
    sourceAccountId: row.source_account_id,
  }));
}

export async function setPortalUserUpstreamAssignment(input: {
  ownerUserId: string;
  sourceAccountId: string | null;
}) {
  if (!input.sourceAccountId) {
    const user = await query<{ id: string }>(
      `SELECT id FROM portal_users WHERE id = $1::uuid LIMIT 1`,
      [input.ownerUserId],
    );
    if (!user.rows[0]) return null;
    await query(
      `DELETE FROM portal_user_upstream_assignments WHERE owner_user_id = $1::uuid`,
      [input.ownerUserId],
    );
    return { assigned: false as const, sourceAccountId: null };
  }
  const result = await query<{ source_account_id: string }>(
    `
      INSERT INTO portal_user_upstream_assignments (
        owner_user_id, source_account_id
      )
      SELECT users.id, accounts.id
      FROM portal_users AS users
      CROSS JOIN openai_accounts AS accounts
      WHERE users.id = $1::uuid
        AND accounts.id = $2::uuid
        AND LOWER(TRIM(accounts.status)) <> 'disabled'
      ON CONFLICT (owner_user_id) DO UPDATE SET
        source_account_id = EXCLUDED.source_account_id,
        updated_at = now()
      RETURNING source_account_id
    `,
    [input.ownerUserId, input.sourceAccountId],
  );
  const row = result.rows[0];
  return row
    ? { assigned: true as const, sourceAccountId: row.source_account_id }
    : null;
}
