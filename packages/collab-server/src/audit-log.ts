/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Audit log.
 *
 * Spec §14: every server-mediated event is logged with
 * `(timestamp, user, room, op-type, op-hash)`. The log is append-only and
 * the consumer chooses where to put it (memory for tests, file for dev,
 * S3 in v0.5).
 *
 * The op-hash is a small content hash of the binary update so an operator
 * can reconstruct what actually changed from the persisted log even after
 * Y.Doc compaction.
 */

import type { Principal } from './auth.js';

export type AuditOpType =
  | 'connect'
  | 'disconnect'
  | 'sync-step1'
  | 'sync-step2'
  | 'update'
  | 'awareness'
  | 'reject';

export interface AuditEntry {
  timestamp: string;
  userId: string;
  role: Principal['role'];
  roomId: string;
  opType: AuditOpType;
  /** Hex-encoded short hash of the operation payload. Empty for control events. */
  opHash: string;
  /** Optional structured detail (e.g. close code, byte count). */
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>;
}

/** In-memory sink. Useful for tests and as a fallback. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  clear(): void {
    this.entries.length = 0;
  }
}

/** Default: drop everything. The server uses this when no sink is supplied. */
export const noopAuditSink: AuditSink = {
  append() {
    /* drop */
  },
};

/**
 * 32-bit FNV-1a hash of a binary payload, returned as 8 hex chars. Tiny,
 * dependency-free, collision properties good enough to identify which
 * update an entry refers to. For high-assurance audit needs, swap in
 * SHA-256 via a custom sink.
 */
export function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
