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
import * as fs from 'node:fs';
import * as path from 'node:path';

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

export interface JsonlFileAuditSinkOptions {
  /** Destination file path. Created if missing. */
  filePath: string;
  /**
   * Soft size cap in bytes after which the active file is renamed with a
   * timestamp suffix and a fresh one is opened (default: never rotate).
   */
  rotateAtBytes?: number;
  /**
   * If true, fsync after every append. Slower but durable. Default false.
   */
  fsync?: boolean;
}

/**
 * Append-only JSONL file sink.
 *
 * One JSON entry per line. Safe under concurrent appends from the same
 * Node process (Node's fs.appendFile uses an internal queue). Rotates
 * when the active file exceeds `rotateAtBytes`.
 */
export class JsonlFileAuditSink implements AuditSink {
  private bytesWritten = 0;
  private readonly filePath: string;
  private readonly rotateAtBytes: number;
  private readonly fsync: boolean;
  private inflight: Promise<void> = Promise.resolve();

  constructor(opts: JsonlFileAuditSinkOptions) {
    this.filePath = opts.filePath;
    this.rotateAtBytes = opts.rotateAtBytes ?? Number.POSITIVE_INFINITY;
    this.fsync = opts.fsync ?? false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath)) {
      this.bytesWritten = fs.statSync(this.filePath).size;
    }
  }

  append(entry: AuditEntry): Promise<void> {
    // Serialize all writes through one chain so size accounting and
    // rotation observe a consistent state.
    this.inflight = this.inflight.then(() => this.appendInner(entry));
    return this.inflight;
  }

  private async appendInner(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.bytesWritten + bytes > this.rotateAtBytes && this.bytesWritten > 0) {
      await this.rotate();
    }
    if (this.fsync) {
      const fd = await fs.promises.open(this.filePath, 'a');
      try {
        await fd.appendFile(line);
        await fd.sync();
      } finally {
        await fd.close();
      }
    } else {
      await fs.promises.appendFile(this.filePath, line);
    }
    this.bytesWritten += bytes;
  }

  private async rotate(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = `${this.filePath}.${stamp}`;
    try {
      await fs.promises.rename(this.filePath, rotated);
      this.bytesWritten = 0;
    } catch (err) {
      // If the source has already been moved by an external process,
      // continue against the empty path.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.bytesWritten = 0;
    }
  }

  /** Force any pending writes to finish. Useful in tests. */
  async flush(): Promise<void> {
    await this.inflight;
  }
}

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
