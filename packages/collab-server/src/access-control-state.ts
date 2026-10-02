/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The on-disk side of `createAccessControl`: reading `access-control.json`
 * (fail closed on any malformed shape) and enumerating the rooms
 * `FilePersistence` has already written to the data dir.
 *
 * File shape: `{ revoked, claimedRooms, pendingClaims }`. `claimedRooms` lists
 * every claimed room, pending ones included, so a server that predates
 * `pendingClaims` (#6581) reads them as claimed rather than free. A file
 * without `pendingClaims` loads every claim as confirmed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FALLBACK_TOKEN_RETENTION_SEC } from './room-claims.js';

/** `stat` errors meaning no file can exist at the path (see `hasPersistedRoomLog`). */
const NO_FILE_POSSIBLE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']);

/**
 * Whether `FilePersistence` would load a log for `roomId` from `dir`: under
 * its encoded name, or under the pre-encoding sanitized name it still reads.
 * Answers `true` whenever it cannot tell (an id with no encoded form, an I/O
 * error): the caller never releases or expires a room that has a log, so
 * "cannot tell" must land on the side that keeps the claim.
 *
 * `stat` is injectable so tests can raise any error code on any platform.
 */
export function hasPersistedRoomLog(
  dir: string,
  roomId: string,
  stat: (file: string) => unknown = fs.statSync,
): boolean {
  const exists = (name: string): boolean => {
    try {
      stat(path.join(dir, name));
      return true;
    } catch (err) {
      // Every code is classified here rather than through `statSync`'s
      // `throwIfNoEntry: false`, which treats ENOTDIR differently on Linux
      // and macOS. Each code below says no file can be at that path:
      // nothing there (ENOENT), a component of `dir` is not a directory
      // (ENOTDIR: FilePersistence could not have written a log under it),
      // or the name is too long for the file system to hold (ENAMETOOLONG).
      // Any other error (EACCES, EIO, ...) means "cannot tell".
      if (NO_FILE_POSSIBLE.has(String((err as NodeJS.ErrnoException).code))) return false;
      // eslint-disable-next-line no-console
      console.warn(`[collab-server] cannot check ${name} in the data dir; keeping its claim:`, err);
      return true;
    }
  };
  let encoded: string;
  try {
    encoded = encodeURIComponent(roomId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[collab-server] room id has no encoded form; keeping its claim:', err);
    return true;
  }
  return exists(`${encoded}.log`) || exists(`${roomId.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
}

/**
 * Enumerate room ids already persisted by `FilePersistence` in `dir`: rooms
 * live as top-level `<encodeURIComponent(roomId)>.log` files (blobs and the
 * layer registry live in subdirectories, which are skipped). Pre-encoding
 * legacy logs used a lossy sanitizer; for those the decoded name IS the
 * sanitized id (best effort — claiming under it still blocks first-touch
 * mints for the ids the server would map to that log).
 */
export function listPersistedRoomIds(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // no data dir yet: genuinely fresh
    // Cannot tell "fresh install" from "existing rooms": fail closed rather
    // than run a server whose rooms are silently up for first-claim grabs.
    throw new Error(
      `[collab-server] access-control state is missing and the data dir cannot be enumerated (${String(err)}); refusing to start open`,
    );
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const base = entry.name.slice(0, -'.log'.length);
    try {
      ids.push(decodeURIComponent(base));
    } catch {
      ids.push(base); // malformed escape: legacy/foreign name, claim it verbatim
    }
  }
  return ids;
}

export interface StateWriter {
  /** Mark the state dirty and schedule a debounced write. */
  persist(): void;
  /** Await any pending/in-flight write; rejects when the latest state never reached disk. */
  flush(): Promise<void>;
}

/**
 * Debounced, atomic writer for the state file. Persistence used to be a
 * synchronous full-file `writeFileSync` on *every* claim/revocation — a cheap
 * way for an attacker looping mint calls to pin the event loop on disk I/O.
 * Writes now coalesce behind a short debounce and a single in-flight drain,
 * so a burst of claims collapses to one async write. The write is atomic
 * (temp file in the same dir, then rename over the target) so a crash
 * mid-write can never leave a torn/corrupt state file.
 *
 * `serialize` runs at write time and returns the file's text, plus an
 * optional callback run once that text is in place.
 */
export function createStateWriter(opts: {
  dir: string;
  statePath: string;
  debounceMs: number;
  serialize: () => { text: string; written?: () => void };
}): StateWriter {
  const { dir, statePath } = opts;
  const tmpPath = `${statePath}.tmp`;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;
  let dirty = false;
  /** Last write failure — `flush()` must not resolve as if state landed. */
  let lastWriteError: unknown = null;
  const writeOnce = async () => {
    try {
      const { text, written } = opts.serialize();
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(tmpPath, text);
      await fs.promises.rename(tmpPath, statePath);
      written?.();
      lastWriteError = null;
    } catch (err) {
      lastWriteError = err;
      // eslint-disable-next-line no-console
      console.warn('[collab-server] could not persist access-control state:', err);
    }
  };
  // Serialized drain: one writer at a time; a change landing while a write is
  // in flight re-marks `dirty`, and the loop runs one more pass so the
  // snapshot on disk is never stale. On failure the state is still dirty
  // (disk is stale) but the loop stops instead of spinning; the next
  // persist()/flush() retries.
  const drain = async () => {
    while (dirty) {
      dirty = false;
      await writeOnce();
      if (lastWriteError !== null) {
        dirty = true;
        break;
      }
    }
  };
  const kick = () => {
    if (!writing) {
      writing = drain().finally(() => {
        writing = null;
      });
    }
  };
  return {
    persist() {
      dirty = true;
      if (writeTimer || writing) return;
      writeTimer = setTimeout(() => {
        writeTimer = null;
        kick();
      }, opts.debounceMs);
      // Don't keep the event loop alive solely for a pending persist.
      writeTimer.unref?.();
    },
    async flush() {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      while (dirty || writing) {
        kick();
        await writing;
        // One retry per flush call: a persistent failure (unwritable volume)
        // must reject, not loop forever.
        if (lastWriteError !== null) break;
      }
      if (lastWriteError !== null) {
        throw new Error(
          `[collab-server] access-control state could not be persisted to ${statePath}: ${String(lastWriteError)}`,
        );
      }
    },
  };
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parsed persistent state; throws on any malformed shape (fail closed). */
export function parseStateFile(raw: string, statePath: string): {
  revoked: Map<string, number>;
  claimedRooms: string[];
  pendingClaims: Map<string, { at: number; tokens: Map<string, number> }>;
} {
  const fail = (why: string): never => {
    throw new Error(
      `[collab-server] access-control state at ${statePath} is ${why}; refusing to start open. ` +
        'Restore the file from backup or delete it deliberately (deleting forgets revocations).',
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('not a JSON object');
  }
  const rec = parsed as { revoked?: unknown; claimedRooms?: unknown; pendingClaims?: unknown };
  const claimedRooms: string[] = [];
  if (rec.claimedRooms !== undefined) {
    if (!Array.isArray(rec.claimedRooms) || rec.claimedRooms.some((r) => typeof r !== 'string')) {
      return fail('malformed (claimedRooms must be an array of strings)');
    }
    claimedRooms.push(...(rec.claimedRooms as string[]));
  }
  // A Map, not `{}`: room ids are client-chosen, and assigning `__proto__`
  // on a plain object would set its prototype instead of storing the claim.
  const pendingClaims = new Map<string, { at: number; tokens: Map<string, number> }>();
  if (rec.pendingClaims !== undefined) {
    if (rec.pendingClaims === null || typeof rec.pendingClaims !== 'object' || Array.isArray(rec.pendingClaims)) {
      return fail('malformed (pendingClaims must be an object of room -> { at, tokens })');
    }
    for (const [room, claim] of Object.entries(rec.pendingClaims as Record<string, unknown>)) {
      const c = claim as { at?: unknown; tokens?: unknown } | null;
      const tokens = c?.tokens;
      if (
        !isFiniteNumber(c?.at) ||
        tokens === null ||
        typeof tokens !== 'object' ||
        Array.isArray(tokens) ||
        !Object.values(tokens as Record<string, unknown>).every(isFiniteNumber)
      ) {
        return fail(`malformed (pendingClaims["${room}"] must be { at, tokens: jti -> exp })`);
      }
      pendingClaims.set(room, { at: c.at, tokens: new Map(Object.entries(tokens as Record<string, number>)) });
    }
  }
  const revoked = new Map<string, number>();
  const nowSec = Math.floor(Date.now() / 1000);
  if (Array.isArray(rec.revoked)) {
    // Legacy shape: `revoked: ["jti", ...]` (no expiries). Assign the
    // fallback retention horizon so the entries stay prunable.
    if (rec.revoked.some((j) => typeof j !== 'string')) {
      return fail('malformed (legacy revoked entries must be strings)');
    }
    for (const jti of rec.revoked as string[]) {
      revoked.set(jti, nowSec + FALLBACK_TOKEN_RETENTION_SEC);
    }
  } else if (rec.revoked !== undefined) {
    // Current shape: `revoked: { jti: expSeconds, ... }`.
    if (typeof rec.revoked !== 'object' || rec.revoked === null) {
      return fail('malformed (revoked must be an array or an object of jti -> exp)');
    }
    for (const [jti, exp] of Object.entries(rec.revoked as Record<string, unknown>)) {
      if (!isFiniteNumber(exp)) {
        return fail(`malformed (revoked["${jti}"] must be a finite expiry in seconds)`);
      }
      revoked.set(jti, exp);
    }
  }
  return { revoked, claimedRooms, pendingClaims };
}
