import type { PoolClient } from "pg";

import { query, withTransaction } from "../core/db.ts";

type UpstreamQuotaWindowRow = {
  source_account_id: string;
  quota_pool: UpstreamQuotaPool;
  reset_at: string;
  used_percent: number | string;
  carry_in_percent: number | string;
  carry_in_user_id: string | null;
  sync_required: boolean;
  initialized_at: Date;
  updated_at: Date;
};

export type UpstreamQuotaPool = "standard" | "spark";

export type UpstreamQuotaWindowState = {
  sourceAccountId: string;
  quotaPool: UpstreamQuotaPool;
  resetAt: number;
  usedPercent: number;
  carryInPercent: number;
  carryInUserId: string | null;
  syncRequired: boolean;
  initializedAt: string;
  updatedAt: string;
};

export type UserUpstreamQuotaAllocation = UpstreamQuotaWindowState & {
  userUsageAmount: number;
  totalUsageAmount: number;
  allocatedPercent: number;
};

export type UpstreamQuotaMemberAllocation = {
  ownerUserId: string;
  username: string;
  role: "admin" | "user";
  enabled: boolean;
  usageAmount: number;
  allocatedPercent: number;
};

export type UpstreamQuotaMemberAllocations = UpstreamQuotaWindowState & {
  totalUsageAmount: number;
  members: UpstreamQuotaMemberAllocation[];
};

function mapWindow(row: UpstreamQuotaWindowRow): UpstreamQuotaWindowState {
  return {
    sourceAccountId: row.source_account_id,
    quotaPool: row.quota_pool,
    resetAt: Number(row.reset_at),
    usedPercent: Number(row.used_percent),
    carryInPercent: Number(row.carry_in_percent),
    carryInUserId: row.carry_in_user_id,
    syncRequired: row.sync_required,
    initializedAt: row.initialized_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findCarryInUserId(client: PoolClient, sourceAccountId: string) {
  const result = await client.query<{ id: string }>(
    `
      SELECT users.id
      FROM portal_users AS users
      JOIN portal_user_upstream_assignments AS assignments
        ON assignments.owner_user_id = users.id
      WHERE assignments.source_account_id = $1::uuid
      ORDER BY (users.role = 'admin') DESC, users.created_at ASC
      LIMIT 1
    `,
    [sourceAccountId],
  );
  return result.rows[0]?.id ?? null;
}

async function lockWindow(
  client: PoolClient,
  sourceAccountId: string,
  quotaPool: UpstreamQuotaPool,
) {
  const result = await client.query<UpstreamQuotaWindowRow>(
    `
      SELECT
        source_account_id, quota_pool, reset_at, used_percent, carry_in_percent,
        carry_in_user_id, sync_required, initialized_at, updated_at
      FROM upstream_quota_windows
      WHERE source_account_id = $1::uuid AND quota_pool = $2
      FOR UPDATE
    `,
    [sourceAccountId, quotaPool],
  );
  return result.rows[0] ? mapWindow(result.rows[0]) : null;
}

async function hasTrackedWindowUsage(
  client: PoolClient,
  sourceAccountId: string,
  quotaPool: UpstreamQuotaPool,
  resetAt: number,
) {
  const result = await client.query<{ found: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM upstream_user_window_usage
        WHERE source_account_id = $1::uuid
          AND quota_pool = $2
          AND reset_at = $3
          AND usage_amount > 0
      ) AS found
    `,
    [sourceAccountId, quotaPool, resetAt],
  );
  return result.rows[0]?.found === true;
}

async function syncWindowWithClient(
  client: PoolClient,
  input: {
    sourceAccountId: string;
    quotaPool: UpstreamQuotaPool;
    resetAt: number;
    usedPercent: number;
    carryCurrentUsageOnCreate: boolean;
    markSynchronized: boolean;
  },
) {
  const current = await lockWindow(
    client,
    input.sourceAccountId,
    input.quotaPool,
  );
  if (!current) {
    const shouldCarryCurrentUsage =
      input.carryCurrentUsageOnCreate && input.usedPercent > 0;
    const carryInUserId = shouldCarryCurrentUsage
      ? await findCarryInUserId(client, input.sourceAccountId)
      : null;
    if (shouldCarryCurrentUsage && !carryInUserId) {
      throw new Error("An assigned user is required to initialize upstream quota");
    }
    const carryInPercent = shouldCarryCurrentUsage ? input.usedPercent : 0;
    const inserted = await client.query<UpstreamQuotaWindowRow>(
      `
        INSERT INTO upstream_quota_windows (
          source_account_id, quota_pool, reset_at, used_percent,
          carry_in_percent, carry_in_user_id, sync_required
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, NOT $7::boolean)
        ON CONFLICT (source_account_id, quota_pool) DO NOTHING
        RETURNING
          source_account_id, quota_pool, reset_at, used_percent, carry_in_percent,
          carry_in_user_id, sync_required, initialized_at, updated_at
      `,
      [
        input.sourceAccountId,
        input.quotaPool,
        input.resetAt,
        input.usedPercent,
        carryInPercent,
        carryInUserId,
        input.markSynchronized,
      ],
    );
    if (inserted.rows[0]) return mapWindow(inserted.rows[0]);
    return syncWindowWithClient(client, input);
  }

  const startsNewCycle = input.usedPercent < current.usedPercent;
  const hasTrackedUsage = await hasTrackedWindowUsage(
    client,
    input.sourceAccountId,
    input.quotaPool,
    current.resetAt,
  );
  const preserveResetAt =
    !startsNewCycle && (current.carryInPercent > 0 || hasTrackedUsage);
  const nextResetAt = preserveResetAt ? current.resetAt : input.resetAt;
  const result = await client.query<UpstreamQuotaWindowRow>(
    `
      UPDATE upstream_quota_windows
      SET
        reset_at = $2,
        used_percent = CASE
          WHEN $6::boolean THEN $3
          ELSE GREATEST(used_percent, $3)
        END,
        carry_in_percent = CASE WHEN $6::boolean THEN 0 ELSE carry_in_percent END,
        carry_in_user_id = CASE WHEN $6::boolean THEN NULL ELSE carry_in_user_id END,
        sync_required = NOT $4::boolean,
        initialized_at = CASE WHEN $6::boolean THEN now() ELSE initialized_at END,
        updated_at = now()
      WHERE source_account_id = $1::uuid AND quota_pool = $5
      RETURNING
        source_account_id, quota_pool, reset_at, used_percent, carry_in_percent,
        carry_in_user_id, sync_required, initialized_at, updated_at
    `,
    [
      input.sourceAccountId,
      nextResetAt,
      input.usedPercent,
      input.markSynchronized,
      input.quotaPool,
      startsNewCycle,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to synchronize upstream quota window");
  return mapWindow(row);
}

export async function getUpstreamQuotaWindow(input: {
  sourceAccountId: string;
  quotaPool: UpstreamQuotaPool;
}) {
  const result = await query<UpstreamQuotaWindowRow>(
    `
      SELECT
        source_account_id, quota_pool, reset_at, used_percent, carry_in_percent,
        carry_in_user_id, sync_required, initialized_at, updated_at
      FROM upstream_quota_windows
      WHERE source_account_id = $1::uuid AND quota_pool = $2
      LIMIT 1
    `,
    [input.sourceAccountId, input.quotaPool],
  );
  return result.rows[0] ? mapWindow(result.rows[0]) : null;
}

export async function syncUpstreamQuotaWindow(input: {
  sourceAccountId: string;
  quotaPool: UpstreamQuotaPool;
  resetAt: number;
  usedPercent: number;
  carryCurrentUsageOnCreate?: boolean;
}) {
  return withTransaction((client) =>
    syncWindowWithClient(client, {
      ...input,
      carryCurrentUsageOnCreate: input.carryCurrentUsageOnCreate ?? true,
      markSynchronized: true,
    }),
  );
}

async function allocationWithClient(
  client: PoolClient,
  sourceAccountId: string,
  quotaPool: UpstreamQuotaPool,
  ownerUserId: string,
) {
  const window = await lockWindow(client, sourceAccountId, quotaPool);
  if (!window) return null;
  const result = await client.query<{
    user_usage_amount: number | string;
    total_usage_amount: number | string;
  }>(
    `
      SELECT
        COALESCE(SUM(usage_amount) FILTER (
          WHERE owner_user_id = $4::uuid
        ), 0)::text AS user_usage_amount,
        COALESCE(SUM(usage_amount), 0)::text AS total_usage_amount
      FROM upstream_user_window_usage
      WHERE source_account_id = $1::uuid
        AND quota_pool = $2
        AND reset_at = $3
    `,
    [sourceAccountId, quotaPool, window.resetAt, ownerUserId],
  );
  const userUsageAmount = Number(result.rows[0]?.user_usage_amount ?? "0");
  const totalUsageAmount = Number(result.rows[0]?.total_usage_amount ?? "0");
  const trackedPercent = Math.max(
    0,
    window.usedPercent - window.carryInPercent,
  );
  const trackedAllocation =
    totalUsageAmount > 0
      ? (trackedPercent * userUsageAmount) / totalUsageAmount
      : 0;
  const carryIn =
    window.carryInUserId === ownerUserId ? window.carryInPercent : 0;
  return {
    ...window,
    userUsageAmount,
    totalUsageAmount,
    allocatedPercent: carryIn + trackedAllocation,
  } satisfies UserUpstreamQuotaAllocation;
}

export async function getUserUpstreamQuotaAllocation(input: {
  sourceAccountId: string;
  quotaPool: UpstreamQuotaPool;
  ownerUserId: string;
}) {
  return withTransaction((client) =>
    allocationWithClient(
      client,
      input.sourceAccountId,
      input.quotaPool,
      input.ownerUserId,
    ),
  );
}

export async function listUpstreamQuotaMemberAllocations(input: {
  sourceAccountId: string;
  quotaPool: UpstreamQuotaPool;
}) {
  return withTransaction(async (client) => {
    const window = await lockWindow(
      client,
      input.sourceAccountId,
      input.quotaPool,
    );
    if (!window) return null;
    const result = await client.query<{
      owner_user_id: string;
      username: string;
      role: string;
      enabled: boolean;
      usage_amount: number | string;
    }>(
      `
        SELECT
          users.id AS owner_user_id,
          users.username,
          users.role,
          users.enabled,
          COALESCE(usage.usage_amount, 0)::text AS usage_amount
        FROM portal_users AS users
        JOIN portal_user_upstream_assignments AS assignments
          ON assignments.owner_user_id = users.id
          AND assignments.source_account_id = $1::uuid
        LEFT JOIN upstream_user_window_usage AS usage
          ON usage.owner_user_id = users.id
          AND usage.source_account_id = $1::uuid
          AND usage.quota_pool = $2
          AND usage.reset_at = $3
        ORDER BY users.created_at ASC
      `,
      [input.sourceAccountId, input.quotaPool, window.resetAt],
    );
    const total = await client.query<{ usage_amount: number | string }>(
      `
        SELECT COALESCE(SUM(usage_amount), 0)::text AS usage_amount
        FROM upstream_user_window_usage
        WHERE source_account_id = $1::uuid
          AND quota_pool = $2
          AND reset_at = $3
      `,
      [input.sourceAccountId, input.quotaPool, window.resetAt],
    );
    const totalUsageAmount = Number(total.rows[0]?.usage_amount ?? "0");
    const trackedPercent = Math.max(
      0,
      window.usedPercent - window.carryInPercent,
    );
    return {
      ...window,
      totalUsageAmount,
      members: result.rows.map((row) => {
        const usageAmount = Number(row.usage_amount);
        const trackedAllocation =
          totalUsageAmount > 0
            ? (trackedPercent * usageAmount) / totalUsageAmount
            : 0;
        const carryIn =
          window.carryInUserId === row.owner_user_id
            ? window.carryInPercent
            : 0;
        return {
          ownerUserId: row.owner_user_id,
          username: row.username,
          role: row.role === "admin" ? "admin" : "user",
          enabled: row.enabled,
          usageAmount,
          allocatedPercent: carryIn + trackedAllocation,
        };
      }),
    } satisfies UpstreamQuotaMemberAllocations;
  });
}

export async function recordUserUpstreamQuotaUsage(input: {
  settlementId: string;
  sourceAccountId: string;
  quotaPool: UpstreamQuotaPool;
  ownerUserId: string;
  resetAt: number;
  usedPercent: number;
  usageAmount: string;
  synchronized: boolean;
}) {
  return withTransaction(async (client) => {
    await syncWindowWithClient(client, {
      sourceAccountId: input.sourceAccountId,
      quotaPool: input.quotaPool,
      resetAt: input.resetAt,
      usedPercent: input.usedPercent,
      carryCurrentUsageOnCreate: false,
      markSynchronized: input.synchronized,
    });
    const inserted = await client.query<{ settlement_id: string }>(
      `
        INSERT INTO upstream_quota_settlements (
          settlement_id, source_account_id, quota_pool, reset_at,
          owner_user_id, usage_amount
        )
        VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6::numeric)
        ON CONFLICT (settlement_id, quota_pool) DO NOTHING
        RETURNING settlement_id
      `,
      [
        input.settlementId,
        input.sourceAccountId,
        input.quotaPool,
        input.resetAt,
        input.ownerUserId,
        input.usageAmount,
      ],
    );
    if (inserted.rows[0]) {
      await client.query(
        `
          INSERT INTO upstream_user_window_usage (
            source_account_id, quota_pool, reset_at,
            owner_user_id, usage_amount
          )
          VALUES ($1::uuid, $2, $3, $4::uuid, $5::numeric)
          ON CONFLICT (
            source_account_id, quota_pool, reset_at, owner_user_id
          )
          DO UPDATE SET
            usage_amount = upstream_user_window_usage.usage_amount
              + EXCLUDED.usage_amount,
            updated_at = now()
        `,
        [
          input.sourceAccountId,
          input.quotaPool,
          input.resetAt,
          input.ownerUserId,
          input.usageAmount,
        ],
      );
    }
    return allocationWithClient(
      client,
      input.sourceAccountId,
      input.quotaPool,
      input.ownerUserId,
    );
  });
}
