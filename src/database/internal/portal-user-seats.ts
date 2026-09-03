import type { PoolClient } from "pg";

export const MAX_PORTAL_USERS = 4;

const PORTAL_USER_SEAT_LOCK_KEY = 8_453_201_114_258n;

export async function lockPortalUserSeats(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    PORTAL_USER_SEAT_LOCK_KEY.toString(),
  ]);
}

export async function getPortalUserSeatUsage(client: PoolClient) {
  const result = await client.query<{
    users: string;
    available_invitations: string;
  }>(
    `
      SELECT
        (SELECT COUNT(*)::text FROM portal_users) AS users,
        (
          SELECT COUNT(*)::text
          FROM portal_user_invitations
          WHERE used_at IS NULL AND expires_at > now()
        ) AS available_invitations
    `,
  );
  return {
    users: Number(result.rows[0]?.users ?? "0"),
    availableInvitations: Number(
      result.rows[0]?.available_invitations ?? "0",
    ),
  };
}
