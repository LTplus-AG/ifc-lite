/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retention policy (spec §12.2 + open problem #9).
 *
 * Storing every Y update for years × every project is expensive. The
 * default policy we ship: keep the full update log for `fullLogDays`
 * (90 by default), then keep only periodic snapshots after that.
 *
 * The server's `RoomManager` already compacts every `compactEvery`
 * updates; this module adds the "drop old log frames" step that runs
 * out-of-band. It is written as pure functions so a deployment can
 * trigger it from cron, a queue, or a Lambda — wherever fits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RetentionPolicy {
  /** Keep the raw append-only log for this many days. Default 90. */
  fullLogDays?: number;
  /** Keep compacted snapshots for this many days. Default 365 * 5. */
  snapshotsDays?: number;
  /** Optional cap on total bytes per room. Soft — we trim oldest first. */
  maxBytesPerRoom?: number;
}

export const DEFAULT_RETENTION: Required<Omit<RetentionPolicy, 'maxBytesPerRoom'>> &
  Pick<RetentionPolicy, 'maxBytesPerRoom'> = {
  fullLogDays: 90,
  snapshotsDays: 365 * 5,
  maxBytesPerRoom: undefined,
};

export interface RetentionDecision {
  /** Files to delete entirely. */
  drop: string[];
  /** Bytes that will be reclaimed once `drop` is processed. */
  reclaimBytes: number;
}

interface FileFact {
  filePath: string;
  bytes: number;
  /** Wall-clock ms of mtime. */
  ageMs: number;
}

/**
 * Plan retention for a directory of room logs/snapshots.
 *
 * Naming convention used by `FilePersistence`:
 *   - `<roomId>.log`            ← active log (never deleted by this fn)
 *   - `<roomId>.log.<isoStamp>` ← rotated logs (auditable)
 *   - `<roomId>.snap.<isoStamp>` ← periodic snapshots (kept longer)
 *
 * Tools shipping their own naming convention can pass a custom matcher
 * via the `classify` option.
 */
export function planRetention(
  dir: string,
  policy: RetentionPolicy = {},
  options: { classify?: (file: string) => 'active' | 'log' | 'snapshot' | 'unknown' } = {},
): RetentionDecision {
  if (!fs.existsSync(dir)) return { drop: [], reclaimBytes: 0 };
  const cfg: Required<Omit<RetentionPolicy, 'maxBytesPerRoom'>> &
    Pick<RetentionPolicy, 'maxBytesPerRoom'> = {
    ...DEFAULT_RETENTION,
    ...policy,
  };
  const classify = options.classify ?? defaultClassify;
  const now = Date.now();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const facts: FileFact[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    const stat = fs.statSync(filePath);
    facts.push({ filePath, bytes: stat.size, ageMs: now - stat.mtimeMs });
  }

  const drop: string[] = [];
  let reclaim = 0;
  for (const f of facts) {
    const kind = classify(path.basename(f.filePath));
    if (kind === 'active' || kind === 'unknown') continue;
    const ageDays = f.ageMs / (1000 * 60 * 60 * 24);
    const maxDays = kind === 'snapshot' ? cfg.snapshotsDays : cfg.fullLogDays;
    if (ageDays > maxDays) {
      drop.push(f.filePath);
      reclaim += f.bytes;
    }
  }

  if (cfg.maxBytesPerRoom != null) {
    // Trim from oldest until under cap.
    const remaining = facts
      .filter((f) => !drop.includes(f.filePath))
      .sort((a, b) => b.ageMs - a.ageMs);
    const total = remaining.reduce((s, f) => s + f.bytes, 0);
    let over = total - cfg.maxBytesPerRoom;
    while (over > 0 && remaining.length > 0) {
      const oldest = remaining.shift()!;
      const kind = classify(path.basename(oldest.filePath));
      if (kind === 'active') continue;
      drop.push(oldest.filePath);
      reclaim += oldest.bytes;
      over -= oldest.bytes;
    }
  }

  return { drop, reclaimBytes: reclaim };
}

/** Apply a `RetentionDecision` to disk. Returns the bytes actually freed. */
export async function applyRetention(decision: RetentionDecision): Promise<number> {
  let freed = 0;
  for (const file of decision.drop) {
    try {
      const stat = await fs.promises.stat(file);
      await fs.promises.unlink(file);
      freed += stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // eslint-disable-next-line no-console
        console.error('[collab-server] retention unlink failed:', err);
      }
    }
  }
  return freed;
}

/** Default classifier matching `FilePersistence` naming. */
function defaultClassify(name: string): 'active' | 'log' | 'snapshot' | 'unknown' {
  if (/\.log$/.test(name)) return 'active';
  if (/\.log\..+$/.test(name)) return 'log';
  if (/\.snap\..+$/.test(name)) return 'snapshot';
  return 'unknown';
}
