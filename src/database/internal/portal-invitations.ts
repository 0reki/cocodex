import { withTransaction } from "../core/db.ts";
import {
  getPortalUserSeatUsage,
  lockPortalUserSeats,
  MAX_PORTAL_USERS,
} from "./portal-user-seats.ts";
import type { PortalUserRecord } from "./types.ts";

export type PortalInvitationErrorCode =
  | "invitation_invalid"
  | "invitation_expired"
  | "invitation_used"
  | "user_limit_reached";

export class PortalInvitationError extends Error {
  code: PortalInvitationErrorCode;

  constructor(code: PortalInvitationErrorCode, message: string) {
    super(message);
    this.name = "PortalInvitationError";
    this.code = code;
  }
}

type InvitationRow = {
  id: string;
  invited_by_user_id: string;
  registered_user_id: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

function mapInvitation(row: InvitationRow) {
  return {
    id: row.id,
    invitedByUserId: row.invited_by_user_id,
    registeredUserId: row.registered_user_id,
    expiresAt: row.expires_at.toISOString(),
    usedAt: row.used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createPortalInvitation(input: {
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: string;
}) {
  return withTransaction(async (client) => {
    await lockPortalUserSeats(client);
    const { users, availableInvitations } =
      await getPortalUserSeatUsage(client);
    if (users + availableInvitations >= MAX_PORTAL_USERS) {
      throw new PortalInvitationError(
        "user_limit_reached",
        "All four user seats are already assigned or reserved",
      );
    }

    const result = await client.query<InvitationRow>(
      `
        INSERT INTO portal_user_invitations (
          token_hash, invited_by_user_id, expires_at
        )
        VALUES ($1, $2::uuid, $3::timestamptz)
        RETURNING
          id, invited_by_user_id, registered_user_id,
          expires_at, used_at, created_at
      `,
      [input.tokenHash, input.invitedByUserId, input.expiresAt],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create portal invitation");
    return mapInvitation(row);
  });
}

export async function inspectPortalInvitation(tokenHash: string) {
  return withTransaction(async (client) => {
    const result = await client.query<InvitationRow>(
      `
        SELECT
          id, invited_by_user_id, registered_user_id,
          expires_at, used_at, created_at
        FROM portal_user_invitations
        WHERE token_hash = $1
        LIMIT 1
      `,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      return { valid: false as const, reason: "invitation_invalid" as const };
    }
    if (row.used_at) {
      return { valid: false as const, reason: "invitation_used" as const };
    }
    if (row.expires_at.getTime() <= Date.now()) {
      return { valid: false as const, reason: "invitation_expired" as const };
    }
    return { valid: true as const, invitation: mapInvitation(row) };
  });
}

export async function registerPortalUserWithInvitation(input: {
  tokenHash: string;
  username: string;
  passwordHash: string;
}): Promise<PortalUserRecord> {
  return withTransaction(async (client) => {
    await lockPortalUserSeats(client);
    const invitationResult = await client.query<InvitationRow>(
      `
        SELECT
          id, invited_by_user_id, registered_user_id,
          expires_at, used_at, created_at
        FROM portal_user_invitations
        WHERE token_hash = $1
        FOR UPDATE
      `,
      [input.tokenHash],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) {
      throw new PortalInvitationError(
        "invitation_invalid",
        "Invitation is invalid",
      );
    }
    if (invitation.used_at) {
      throw new PortalInvitationError(
        "invitation_used",
        "Invitation has already been used",
      );
    }
    if (invitation.expires_at.getTime() <= Date.now()) {
      throw new PortalInvitationError(
        "invitation_expired",
        "Invitation has expired",
      );
    }

    const { users } = await getPortalUserSeatUsage(client);
    if (users >= MAX_PORTAL_USERS) {
      throw new PortalInvitationError(
        "user_limit_reached",
        "All four user seats are already assigned",
      );
    }

    const userResult = await client.query<{
      id: string;
      username: string;
      password_hash: string;
      role: string;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        INSERT INTO portal_users (
          username, password_hash, role, enabled
        )
        VALUES ($1, $2, 'user', true)
        RETURNING
          id, username, password_hash, role, enabled,
          created_at, updated_at
      `,
      [input.username.trim().toLowerCase(), input.passwordHash.trim()],
    );
    const user = userResult.rows[0];
    if (!user) throw new Error("Failed to register portal user");

    await client.query(
      `
        UPDATE portal_user_invitations
        SET used_at = now(), registered_user_id = $2::uuid
        WHERE id = $1::uuid
      `,
      [invitation.id, user.id],
    );

    return {
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      role: user.role === "admin" ? "admin" : "user",
      enabled: user.enabled,
      createdAt: user.created_at.toISOString(),
      updatedAt: user.updated_at.toISOString(),
    };
  });
}
