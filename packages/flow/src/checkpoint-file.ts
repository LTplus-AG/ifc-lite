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
 * loser re-reads `applying` and is refused. Locks older than a minute are reclaimed only when their PID is dead.
 * Legacy empty lock files have no owner identity and require manual removal.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
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
    const owner = `${process.pid}-${randomUUID()}`;
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
    if (owners.length !== 1 || !/^[1-9]\d*-/.test(owners[0])) return false;
    const owner = owners[0];
    try {
      if (Date.now() - (await stat(`${lock}/${owner}`)).mtimeMs < 60_000) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    try { process.kill(Number(owner.split('-')[0]), 0); return false; }
    catch (error) {
      // EPERM and all unknown liveness errors preserve the lock.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    await this.release(lock, owner);
    return true;
  }
}

/** What a resume must start from: the model bytes and effective tracking state the paused run left behind. */
export function sourceDigestOf(bytes: Uint8Array | string, trackingFingerprint?: string): string {
  const hash = createHash('sha256').update(bytes);
  if (trackingFingerprint !== undefined) hash.update(`\0tracking:${trackingFingerprint}`);
  return `sha256:${hash.digest('hex')}`;
}
