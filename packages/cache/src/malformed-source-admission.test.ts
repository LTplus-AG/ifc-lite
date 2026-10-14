/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as sourceHash from './utils/hash.js';
import { IfcParser } from '@ifc-lite/parser';
import { toCacheDataStore } from './adapt.js';
import { BinaryCacheWriter } from './writer.js';
import { BinaryCacheReader } from './reader.js';

const source = readFileSync(new URL('../../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');

describe('#7541 binary cache admission retains scanner omissions', () => {
  it('refuses a real partial parser index instead of persisting it without diagnostics', async () => {
    const bytes = new TextEncoder().encode(source).buffer;
    const store = await new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
    expect(Array.from(store.entityIndex.byId.keys())).toEqual([1, 2, 3, 21, 22, 31]);
    expect(store.malformedRecordCount).toBe(1);
    const cache = toCacheDataStore(store);
    expect(cache.malformedRecordCount).toBe(1);
    // Observe calls to the actual implementations; neither return is mocked.
    const hash = vi.spyOn(sourceHash, 'xxhash64');
    const strings = vi.spyOn(cache.strings, 'getAll');
    try {
      await expect(new BinaryCacheWriter().write(cache, undefined, bytes, { includeGeometry: false })).rejects.toThrow(/source index incomplete/);
      expect(hash).not.toHaveBeenCalled();
      expect(strings).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore(); strings.mockRestore();
    }
  });

  it('still writes and reads actual valid doubled-quote source tables', async () => {
    const bytes = new TextEncoder().encode(source.replace("it's", "it''s").replace("Bob's", "Bob''s")).buffer;
    const store = await new IfcParser().parseColumnar(bytes, { disableWorkerScan: true });
    expect(store.malformedRecordCount).toBe(0);
    const buffer = await new BinaryCacheWriter().write(toCacheDataStore(store), undefined, bytes, { includeGeometry: false });
    const restored = await new BinaryCacheReader().read(buffer);
    expect(restored.entityIndex).toBeDefined();
    const index = restored.entityIndex!;
    expect(Array.from(index.ids)).toEqual([1, 2, 3, 20, 21, 22, 30, 31]);
    const row = index.ids.indexOf(21);
    expect(index.typeNames[index.typeIndices[row]]).toBe('IFCWALL');
    const sourceText = new TextDecoder().decode(bytes);
    expect(sourceText.slice(index.byteOffsets[row], index.byteOffsets[row] + index.byteLengths[row]))
      .toBe(sourceText.split('\n').find(line => line.startsWith('#21=')));
    expect(restored.dataStore.entities.getName(21)).toBe('W2');
  });
});
