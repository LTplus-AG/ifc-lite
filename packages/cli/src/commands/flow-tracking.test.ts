/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTrackingPath, FileTrackingStore } from './flow-tracking.js';

const SET = { trackingKey: 'g/n', generation: 0, entries: { k: { globalId: 'G', digest: 'd' } }, nodeType: 't' };

describe('FileTrackingStore', () => {
  it('refuses a sidecar it cannot check: wrong version, malformed sets, or no pin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-tracking-'));
    const path = join(dir, 'g.tracking.json');
    const cases: Array<[string, unknown]> = [
      ['unsupported tracking sidecar version', { version: 2, pinnedTo: 'file:x', sets: {} }],
      ['no valid "sets"', { version: 1, pinnedTo: 'file:x', sets: [] }],
      ['no valid "sets"', { version: 1, pinnedTo: 'file:x', sets: { 'g/n': 'stale' } }],
      ['no "pinnedTo"', { version: 1, sets: { 'g/n': SET } }],
    ];
    for (const [message, sidecar] of cases) {
      await writeFile(path, JSON.stringify(sidecar));
      await expect(FileTrackingStore.open(path, 'file:x')).rejects.toThrow(message);
    }
  });

  it('round-trips sets through flush, reports the loaded pin, and only writes when dirty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-flow-tracking-'));
    const path = defaultTrackingPath(join(dir, 'g.flow.json'));
    expect(path.endsWith('g.tracking.json')).toBe(true);
    const fresh = await FileTrackingStore.open(path, 'file:a');
    expect(fresh.loadedPin).toBeUndefined();
    expect(await fresh.flush()).toBe(false);
    fresh.save(SET);
    expect(await fresh.flush()).toBe(true);

    const again = await FileTrackingStore.open(path, 'file:b');
    expect(again.loadedPin).toBe('file:a');
    expect(again.load('g/n')).toEqual(SET);
    expect(again.keys()).toEqual(['g/n']);
    again.delete('g/n');
    expect(await again.flush()).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ version: 1, pinnedTo: 'file:b', sets: {} });
  });
});
