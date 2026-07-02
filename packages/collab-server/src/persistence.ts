/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pluggable persistence interface.
 *
 * v0.2 ships two implementations:
 *   - `MemoryPersistence` (default for tests)
 *   - `FilePersistence`   (default for `start()` — append-only log per room)
 *
 * v0.5 will add S3 + Redis variants per spec §12.2.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Y from 'yjs';

/**
 * Merge an ordered list of persisted Yjs update frames into one update.
 *
 * A room log is a sequence of independent Y updates (one per `append`). They
 * MUST be combined with `Y.mergeUpdates`, never byte-concatenated:
 * `Y.applyUpdate` decodes only the first update in a naive concatenation and
 * silently ignores the rest, so every edit after the first frame is lost on
 * room reload (up to `compactEvery` updates between compactions).
 */
export function mergeUpdateFrames(frames: Uint8Array[]): Uint8Array {
  return frames.length === 1 ? frames[0] : Y.mergeUpdates(frames);
}

export interface Persistence {
  /** Load any saved updates for `roomId` and return them as a single merged blob. */
  load(roomId: string): Promise<Uint8Array | null>;
  /** Append `update` to `roomId`'s log. */
  append(roomId: string, update: Uint8Array): Promise<void>;
  /** Replace the room's log with a freshly compacted state (called periodically). */
  compact(roomId: string, mergedState: Uint8Array): Promise<void>;
  /** Hard-delete a room. */
  drop(roomId: string): Promise<void>;
}

export class MemoryPersistence implements Persistence {
  private readonly logs = new Map<string, Uint8Array[]>();

  async load(roomId: string): Promise<Uint8Array | null> {
    const arr = this.logs.get(roomId);
    if (!arr || arr.length === 0) return null;
    return mergeUpdateFrames(arr);
  }

  async append(roomId: string, update: Uint8Array): Promise<void> {
    const arr = this.logs.get(roomId) ?? [];
    arr.push(update);
    this.logs.set(roomId, arr);
  }

  async compact(roomId: string, mergedState: Uint8Array): Promise<void> {
    this.logs.set(roomId, [mergedState]);
  }

  async drop(roomId: string): Promise<void> {
    this.logs.delete(roomId);
  }
}

export interface FilePersistenceOptions {
  /** Root directory for room logs. */
  dataDir: string;
}

/**
 * Append-only file-per-room persistence.
 *
 * Update layout: each `append()` writes one frame `[length:u32][bytes]`
 * to `<dataDir>/<sanitizedRoomId>.log`. `load()` reads the file and
 * returns the concatenated payload.
 *
 * Compaction rewrites the log atomically by writing to a temp file then
 * renaming.
 */
export class FilePersistence implements Persistence {
  private readonly dataDir: string;

  constructor(opts: FilePersistenceOptions) {
    this.dataDir = opts.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private logPath(roomId: string): string {
    // Reversible, collision-free, and traversal-safe (encodes `/` and `\`),
    // matching the S3 backend. A lossy `[^a-zA-Z0-9._-] -> _` replace would
    // map distinct rooms (e.g. `a/b` and `a:b`) onto one log file and
    // interleave their updates. Safe ids (UUIDs, room codes) are unchanged, so
    // existing logs keep their names.
    const safe = encodeURIComponent(roomId);
    return path.join(this.dataDir, `${safe}.log`);
  }

  /**
   * Pre-encoding log path (the old lossy `[^a-zA-Z0-9._-] -> _` sanitizer).
   * Lossy — distinct rooms could collide — so it is used ONLY to find and
   * migrate a room's existing log after upgrading to the encoded scheme, never
   * for new writes. Equals `logPath` for ids the old sanitizer left unchanged
   * (UUIDs, room codes), which is the no-migration-needed common case.
   */
  private legacyLogPath(roomId: string): string {
    const safe = roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dataDir, `${safe}.log`);
  }

  async load(roomId: string): Promise<Uint8Array | null> {
    let file = this.logPath(roomId);
    if (!fs.existsSync(file)) {
      // A room persisted before the encoded-filename change still lives under
      // the old sanitized name; read it so history survives the upgrade.
      const legacy = this.legacyLogPath(roomId);
      if (legacy === file || !fs.existsSync(legacy)) return null;
      file = legacy;
    }
    const buf = await fs.promises.readFile(file);
    if (buf.byteLength === 0) return null;
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + 4 <= buf.byteLength) {
      const len = buf.readUInt32LE(offset);
      offset += 4;
      if (offset + len > buf.byteLength) break;
      frames.push(new Uint8Array(buf.buffer, buf.byteOffset + offset, len));
      offset += len;
    }
    if (frames.length === 0) return null;
    return mergeUpdateFrames(frames);
  }

  async append(roomId: string, update: Uint8Array): Promise<void> {
    const file = this.logPath(roomId);
    // One-time migration: adopt a pre-encoding log so appends extend the
    // room's existing history instead of starting a second, empty file.
    if (!fs.existsSync(file)) {
      const legacy = this.legacyLogPath(roomId);
      if (legacy !== file && fs.existsSync(legacy)) {
        await fs.promises.rename(legacy, file);
      }
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(update.byteLength, 0);
    const body = Buffer.concat([header, Buffer.from(update)]);
    await fs.promises.appendFile(file, body);
  }

  async compact(roomId: string, mergedState: Uint8Array): Promise<void> {
    const file = this.logPath(roomId);
    const tmp = `${file}.tmp`;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(mergedState.byteLength, 0);
    await fs.promises.writeFile(tmp, Buffer.concat([header, Buffer.from(mergedState)]));
    await fs.promises.rename(tmp, file);
    // The compacted snapshot supersedes any pre-encoding log; remove it so a
    // future load can't fall back to stale state.
    const legacy = this.legacyLogPath(roomId);
    if (legacy !== file && fs.existsSync(legacy)) {
      await fs.promises.unlink(legacy);
    }
  }

  async drop(roomId: string): Promise<void> {
    for (const file of new Set([this.logPath(roomId), this.legacyLogPath(roomId)])) {
      if (fs.existsSync(file)) {
        await fs.promises.unlink(file);
      }
    }
  }
}
