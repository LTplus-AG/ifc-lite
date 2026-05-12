/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { neon } from '@neondatabase/serverless';
import type {
  ChatConfig,
  ChatUsageStore,
  UsageReservationResult,
  UsageSnapshot,
  UsageTier,
} from './chat-handler';

interface UsageRow {
  user_id: string;
  credits_used: number;
  billing_anchor_at: number | null;
  reset_at: number | null;
  free_requests_used: number | null;
  free_reset_at: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DB_TIMEOUT_MS = 8_000;

class UsageStoreTimeoutError extends Error {
  constructor(operation: string) {
    super(`Usage store timed out during ${operation}`);
    this.name = 'UsageStoreTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new UsageStoreTimeoutError(operation));
    }, DB_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function getNextCycleResetFromAnchor(anchorAt: number, nowMs: number = Date.now()): number {
  let next = new Date(anchorAt);
  if (!Number.isFinite(next.getTime())) {
    next = new Date(nowMs);
  }
  while (next.getTime() <= nowMs) {
    next = new Date(next);
    next.setMonth(next.getMonth() + 1);
  }
  return next.getTime();
}

function buildFreeSnapshot(config: ChatConfig, row: UsageRow): UsageSnapshot {
  const used = Math.max(0, row.free_requests_used ?? 0);
  const resetAt = Math.ceil((row.free_reset_at ?? (Date.now() + DAY_MS)) / 1000);
  return {
    type: 'requests',
    used,
    limit: config.freeDailyLimit,
    pct: Math.min(100, Math.round((used / config.freeDailyLimit) * 100)),
    resetAt,
  };
}

export class SqlChatUsageStore implements ChatUsageStore {
  private readonly readyPromise: Promise<void>;

  constructor(
    private readonly sql: ReturnType<typeof neon>,
    private readonly config: ChatConfig,
  ) {
    // Start schema readiness during cold start instead of waiting for the first request path.
    this.readyPromise = this.bootstrapSchema();
  }

  async getUsageSnapshot(userId: string, _tier: UsageTier): Promise<UsageSnapshot> {
    const row = await this.loadNormalizedRow(userId);
    return buildFreeSnapshot(this.config, row);
  }

  async consumeFreeRequest(userId: string): Promise<UsageReservationResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.loadNormalizedRow(userId);
      const snapshot = buildFreeSnapshot(this.config, row);
      if (snapshot.used >= this.config.freeDailyLimit) {
        return { allowed: false, snapshot };
      }
      const nextCount = (row.free_requests_used ?? 0) + 1;
      const updated = await withTimeout(this.sql`
        UPDATE llm_chat_usage
        SET free_requests_used = ${nextCount},
            updated_at = ${Date.now()}
        WHERE user_id = ${userId}
          AND free_requests_used = ${row.free_requests_used ?? 0}
          AND free_reset_at = ${row.free_reset_at ?? 0}
        RETURNING user_id, credits_used, billing_anchor_at, reset_at, free_requests_used, free_reset_at
      ` as unknown as Promise<UsageRow[]>, 'consumeFreeRequest update');
      if (updated[0]) {
        return { allowed: true, snapshot: buildFreeSnapshot(this.config, updated[0]) };
      }
    }

    const snapshot = await this.getUsageSnapshot(userId, 'free');
    return { allowed: snapshot.used < this.config.freeDailyLimit, snapshot };
  }

  private async bootstrapSchema(): Promise<void> {
    await withTimeout(this.sql`
      CREATE TABLE IF NOT EXISTS llm_chat_usage (
        user_id TEXT PRIMARY KEY,
        credits_used DOUBLE PRECISION NOT NULL DEFAULT 0,
        billing_anchor_at BIGINT NOT NULL DEFAULT 0,
        reset_at BIGINT NOT NULL DEFAULT 0,
        free_requests_used INTEGER NOT NULL DEFAULT 0,
        free_reset_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0
      )
    ` as Promise<unknown>, 'bootstrap create table');
    await withTimeout(this.sql`
      ALTER TABLE llm_chat_usage
      ADD COLUMN IF NOT EXISTS billing_anchor_at BIGINT
    ` as Promise<unknown>, 'bootstrap billing_anchor_at');
    await withTimeout(this.sql`
      ALTER TABLE llm_chat_usage
      ADD COLUMN IF NOT EXISTS free_requests_used INTEGER NOT NULL DEFAULT 0
    ` as Promise<unknown>, 'bootstrap free_requests_used');
    await withTimeout(this.sql`
      ALTER TABLE llm_chat_usage
      ADD COLUMN IF NOT EXISTS free_reset_at BIGINT NOT NULL DEFAULT 0
    ` as Promise<unknown>, 'bootstrap free_reset_at');
  }

  private async ensureReady(): Promise<void> {
    await this.readyPromise;
  }

  private async loadNormalizedRow(userId: string): Promise<UsageRow> {
    await this.ensureReady();
    const now = Date.now();
    const initialAnchorAt = now;
    const initialResetAt = getNextCycleResetFromAnchor(initialAnchorAt, now);
    const initialFreeResetAt = now + DAY_MS;

    await withTimeout(this.sql`
      INSERT INTO llm_chat_usage (
        user_id,
        credits_used,
        billing_anchor_at,
        reset_at,
        free_requests_used,
        free_reset_at,
        updated_at
      )
      VALUES (
        ${userId},
        0,
        ${initialAnchorAt},
        ${initialResetAt},
        0,
        ${initialFreeResetAt},
        ${now}
      )
      ON CONFLICT (user_id) DO NOTHING
    ` as Promise<unknown>, 'loadNormalizedRow insert');

    const rows = await withTimeout(this.sql`
      SELECT user_id, credits_used, billing_anchor_at, reset_at, free_requests_used, free_reset_at
      FROM llm_chat_usage
      WHERE user_id = ${userId}
      LIMIT 1
    ` as unknown as Promise<UsageRow[]>, 'loadNormalizedRow select');
    const row = rows[0];
    if (!row) {
      throw new Error('Failed to load llm_chat_usage row');
    }

    const anchorAt = typeof row.billing_anchor_at === 'number' && row.billing_anchor_at > 0
      ? row.billing_anchor_at
      : initialAnchorAt;
    const resetAt = typeof row.reset_at === 'number' && row.reset_at > 0
      ? row.reset_at
      : initialResetAt;
    const freeResetAt = typeof row.free_reset_at === 'number' && row.free_reset_at > 0
      ? row.free_reset_at
      : initialFreeResetAt;
    const nextCreditsUsed = now >= resetAt ? 0 : (row.credits_used ?? 0);
    const nextResetAt = now >= resetAt ? getNextCycleResetFromAnchor(anchorAt, now) : resetAt;
    const nextFreeUsed = now >= freeResetAt ? 0 : (row.free_requests_used ?? 0);
    const nextFreeResetAt = now >= freeResetAt ? now + DAY_MS : freeResetAt;

    if (
      nextCreditsUsed !== (row.credits_used ?? 0)
      || nextResetAt !== resetAt
      || nextFreeUsed !== (row.free_requests_used ?? 0)
      || nextFreeResetAt !== freeResetAt
      || anchorAt !== row.billing_anchor_at
    ) {
      await withTimeout(this.sql`
        UPDATE llm_chat_usage
        SET credits_used = ${nextCreditsUsed},
            billing_anchor_at = ${anchorAt},
            reset_at = ${nextResetAt},
            free_requests_used = ${nextFreeUsed},
            free_reset_at = ${nextFreeResetAt},
            updated_at = ${now}
        WHERE user_id = ${userId}
      ` as Promise<unknown>, 'loadNormalizedRow normalize');
      return {
        user_id: userId,
        credits_used: nextCreditsUsed,
        billing_anchor_at: anchorAt,
        reset_at: nextResetAt,
        free_requests_used: nextFreeUsed,
        free_reset_at: nextFreeResetAt,
      };
    }

    return {
      ...row,
      billing_anchor_at: anchorAt,
      reset_at: resetAt,
      free_reset_at: freeResetAt,
    };
  }
}
