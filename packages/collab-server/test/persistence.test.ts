/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Y from 'yjs';
import { FilePersistence, MemoryPersistence } from '../src/persistence.js';

/** Real per-transaction update frames, mirroring the server's onDocUpdate. */
function makeFrames(values: number[]): Uint8Array[] {
  const doc = new Y.Doc();
  const frames: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => frames.push(u));
  const arr = doc.getArray<number>('log');
  for (const v of values) doc.transact(() => arr.push([v]));
  return frames;
}

/** Apply a loaded blob to a fresh doc and read back the array it encodes. */
function replay(loaded: Uint8Array | null): number[] {
  const doc = new Y.Doc();
  if (loaded) Y.applyUpdate(doc, loaded);
  return doc.getArray<number>('log').toArray();
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-persist-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('MemoryPersistence', () => {
  it('load reconstructs the full state from all appended frames', async () => {
    const p = new MemoryPersistence();
    expect(await p.load('room')).toBeNull();
    for (const f of makeFrames([1, 2, 3])) await p.append('room', f);
    // Regression: a byte-concatenation applied via Y.applyUpdate decodes only
    // the first frame, dropping every later edit (up to `compactEvery`).
    expect(replay(await p.load('room'))).toEqual([1, 2, 3]);
  });
});

describe('FilePersistence', () => {
  it('load reconstructs the full state across many un-compacted frames', async () => {
    const p = new FilePersistence({ dataDir: tmpDir() });
    const values = Array.from({ length: 20 }, (_, i) => i);
    for (const f of makeFrames(values)) await p.append('room', f);
    expect(replay(await p.load('room'))).toEqual(values);
  });

  it('a compacted snapshot then further appends still load in full', async () => {
    const dir = tmpDir();
    const seed = new Y.Doc();
    const seedArr = seed.getArray<number>('log');
    seed.transact(() => seedArr.push([1, 2]));
    const p = new FilePersistence({ dataDir: dir });
    await p.compact('room', Y.encodeStateAsUpdate(seed));
    // Post-compaction incremental edits continue on the same doc.
    const frames: Uint8Array[] = [];
    seed.on('update', (u: Uint8Array) => frames.push(u));
    seed.transact(() => seedArr.push([3]));
    seed.transact(() => seedArr.push([4]));
    for (const f of frames) await p.append('room', f);
    expect(replay(await p.load('room'))).toEqual([1, 2, 3, 4]);
  });

  it('does not collide distinct room ids that a lossy sanitizer would merge', async () => {
    const dir = tmpDir();
    const p = new FilePersistence({ dataDir: dir });
    // `a/b` and `a:b` both map to `a_b` under a `[^a-zA-Z0-9._-] -> _` replace.
    for (const f of makeFrames([10, 11])) await p.append('a/b', f);
    for (const f of makeFrames([20, 21])) await p.append('a:b', f);
    expect(replay(await p.load('a/b'))).toEqual([10, 11]);
    expect(replay(await p.load('a:b'))).toEqual([20, 21]);
  });
});
