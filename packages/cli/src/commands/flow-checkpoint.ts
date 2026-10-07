/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoints on disk for `ifc-lite flow` (#6923).
 *
 * The file is the same portable record the viewer stores (`FlowCheckpoint`
 * from `@ifc-lite/flow`) plus a revision. Writes are compare-and-swap under
 * an exclusive lock file (`<file>.lock`, created with `wx`), so two
 * processes resuming the same reviewed checkpoint cannot both claim it: the
 * loser re-reads `applying` and is refused. A lock older than
 * `STALE_LOCK_MS` belongs to a process that died inside a write and is
 * taken over.
 */

import { createHash } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { parseCheckpoint, type CheckpointStore, type FlowCheckpoint, type StoredCheckpoint } from '@ifc-lite/flow/checkpoint';

const STALE_LOCK_MS = 30_000;

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
    if (!(await this.acquire(lock))) return false;
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
      await unlink(lock).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }

  private async acquire(lock: string): Promise<boolean> {
    try {
      await (await open(lock, 'wx')).close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age < STALE_LOCK_MS) return false;
      await unlink(lock).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      return false;
    }
  }
}

/** What a resume must start from: the model bytes the paused run left behind. */
export function sourceDigestOf(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
