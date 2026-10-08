/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review checkpoints on disk shared by CLI and MCP Flow hosts (#6923).
 *
 * The file is the same portable record the viewer stores (`FlowCheckpoint`
 * from `@ifc-lite/flow`) plus a revision. Writes are compare-and-swap under
 * an exclusive lock file (`<file>.lock`, created with `wx`), so two
 * processes resuming the same reviewed checkpoint cannot both claim it: the
 * loser re-reads `applying` and is refused. Existing locks are never
 * reclaimed by age: an old lock can still belong to a live writer.
 */

import { createHash } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
      return false;
    }
  }
}

/** What a resume must start from: the model bytes and effective tracking state the paused run left behind. */
export function sourceDigestOf(bytes: Uint8Array | string, trackingFingerprint?: string): string {
  const hash = createHash('sha256').update(bytes);
  if (trackingFingerprint !== undefined) hash.update(`\0tracking:${trackingFingerprint}`);
  return `sha256:${hash.digest('hex')}`;
}
