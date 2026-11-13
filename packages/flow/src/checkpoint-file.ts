/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoints on disk shared by CLI and MCP Flow hosts (#6923).
 *
 * The file is the same portable record the viewer stores (`FlowCheckpoint`
 * from `@ifc-lite/flow`) plus a revision. Writes are compare-and-swap under
 * an exclusive non-empty lock directory (`<file>.lock`), so two
 * processes resuming the same reviewed checkpoint cannot both claim it: the
 * loser re-reads `applying` and is refused. Old locks are reclaimed only after their local process identity is retired.
 * Legacy empty lock files have no owner identity and require manual removal.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { lockOwnerName, parseLockOwner, readLockIdentity, retiredLockOwner } from './checkpoint-lock-owner.js';
import { parseCheckpoint, type CheckpointStore, type FlowCheckpoint, type StoredCheckpoint } from './checkpoint.js';

export class FileCheckpointStore implements CheckpointStore {
  constructor(readonly path: string) {}

  async read(id: string): Promise<StoredCheckpoint | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const value = JSON.parse(text) as { revision?: unknown; checkpoint?: unknown };
    const checkpoint = parseCheckpoint(value.checkpoint);
    if (checkpoint.id !== id || typeof value.revision !== 'number') return null;
    return { checkpoint, revision: value.revision };
  }

  /** The checkpoint in the file, whatever its id. */
  async load(): Promise<StoredCheckpoint> {
    const value = JSON.parse(await readFile(this.path, 'utf-8')) as { checkpoint?: unknown };
    const checkpoint = parseCheckpoint(value.checkpoint);
    const stored = await this.read(checkpoint.id);
    if (!stored) throw new Error(`${this.path} is not a review checkpoint file`);
    return stored;
  }

  async write(checkpoint: FlowCheckpoint, expected: number | null): Promise<boolean> {
    const lock = `${this.path}.lock`;
    const owner = await this.acquire(lock);
    if (!owner) return false;
    try {
      const current = await this.load().catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (current && current.checkpoint.id !== checkpoint.id) return false;
      if ((current?.revision ?? null) !== expected) return false;
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ revision: (current?.revision ?? 0) + 1, checkpoint }, null, 2)}\n`);
      await rename(temp, this.path);
      return true;
    } finally {
      await this.release(lock, owner);
    }
  }

  private async release(lock: string, owner: string): Promise<void> {
    // Remove only OUR owner entry. A late competing reaper cannot unlink a
    // replacement's distinct owner entry, and rmdir cannot remove a nonempty dir.
    await unlink(`${lock}/${owner}`).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await rmdir(lock).catch((error: unknown) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    });
  }

  private async acquire(lock: string): Promise<string | null> {
    await this.reapCandidates(lock);
    const owner = lockOwnerName(await readLockIdentity());
    const candidate = `${lock}.${owner}`;
    await mkdir(candidate);
    try {
      await writeFile(`${candidate}/${owner}`, '');
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Publish a fully populated directory atomically. rename cannot
          // replace another writer's nonempty directory (including on Windows).
          await rename(candidate, lock);
          return owner;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          if (attempt || !(await this.reclaim(lock))) return null;
        }
      }
      return null;
    } finally {
      await this.release(candidate, owner);
    }
  }

  private async reclaim(lock: string): Promise<boolean> {
    let owners: string[];
    try { owners = await readdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        throw new Error(`Legacy checkpoint lock ${lock} has no PID; verify no writer is active before removing it`);
      }
      throw error;
    }
    if (owners.length === 0) {
      await this.release(lock, 'retired');
      return true;
    }
    if (owners.length !== 1) return false;
    const owner = owners[0];
    if (!(await this.oldEnough(`${lock}/${owner}`))) return false;
    const identity = parseLockOwner(owner);
    if (!identity) throw new Error(`Legacy checkpoint lock ${lock} has no process identity; verify its writer before removing it`);
    if (!(await retiredLockOwner(identity, lock))) return false;
    await this.release(lock, owner);
    return true;
  }
  private async oldEnough(path: string): Promise<boolean> {
    try { return Date.now() - (await stat(path)).mtimeMs >= 60_000; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Reap only protocol-owned orphan candidates, never recursively. */
  private async reapCandidates(lock: string): Promise<void> {
    const prefix = `${basename(lock)}.`, parent = dirname(lock);
    const local = await readLockIdentity();
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(parent, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        console.warn('[FileCheckpointStore] Cannot inspect orphan lock candidates:', error);
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const owner = entry.name.slice(prefix.length), identity = parseLockOwner(owner);
      if (!identity || identity.host !== local.host) continue;
      const candidate = `${parent}/${entry.name}`;
      try {
        if (!(await this.oldEnough(candidate))) continue;
        if (await retiredLockOwner(identity, candidate)) await this.release(candidate, owner);
      } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          console.warn('[FileCheckpointStore] Retaining inaccessible orphan candidate:', error);
          continue;
        }
        throw error;
      }
    }
  }

}

/** What a resume must start from: the model bytes and effective tracking state the paused run left behind. */
export function sourceDigestOf(bytes: Uint8Array | string, trackingFingerprint?: string): string {
  const hash = createHash('sha256').update(bytes);
  if (trackingFingerprint !== undefined) hash.update(`\0tracking:${trackingFingerprint}`);
  return `sha256:${hash.digest('hex')}`;
}
