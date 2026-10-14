/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { BinaryCacheReader, BinaryCacheWriter, FORMAT_VERSION, computeSourceFingerprint, toCacheDataStore } from '@ifc-lite/cache';
import { clearCache, getCached, setCached } from '../services/ifc-cache.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';

const text = readFileSync(new URL('../../../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');
beforeEach(async () => { await clearCache(); });
afterEach(async () => { await clearCache(); });
const parse = (buffer: ArrayBuffer) => new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });

function assertRestoredSourceIndex(result: Awaited<ReturnType<BinaryCacheReader['read']>>, bytes: ArrayBuffer, ids: number[]): void {
  assert.ok(result.entityIndex, 'the actual cache reader must return source-addressed columns');
  const index = result.entityIndex;
  assert.deepEqual(Array.from(index.ids), ids);
  const row = index.ids.indexOf(21);
  assert.equal(index.typeNames[index.typeIndices[row]], 'IFCWALL');
  const sourceText = new TextDecoder().decode(bytes);
  assert.equal(sourceText.slice(index.byteOffsets[row], index.byteOffsets[row] + index.byteLengths[row]),
    sourceText.split('\n').find(line => line.startsWith('#21=')));
  assert.equal(result.dataStore.entities.getName(21), 'W2');
}


describe('#7541 old cached partial indexes cannot bypass corrected scanner policy', () => {
  it('keeps explicit legacy tables readable under g5 but misses them on current lookup and reparses', async () => {
    const bytes = new TextEncoder().encode(text).buffer;
    const partial = await parse(bytes);
    assert.equal(partial.malformedRecordCount, 1);
    assert.deepEqual(Array.from(partial.entityIndex.byId.keys()), [1, 2, 3, 21, 22, 31]);
    // Explicit historical wire fixture: old caches stored real partial tables
    // without omission provenance. This is NOT the current cache admission path.
    const { malformedRecordCount: omitted, ...legacyTables } = toCacheDataStore(partial);
    assert.equal(omitted, 1);
    const payload = await new BinaryCacheWriter().write(legacyTables, undefined, bytes, { includeGeometry: false });
    const fingerprint = computeSourceFingerprint(bytes).hex;
    const oldKey = `ifc-${bytes.byteLength}-${fingerprint}-v${FORMAT_VERSION}-g5`;
    await setCached(oldKey, payload, 'authored.ifc', bytes.byteLength, bytes, { lastModified: 1 });
    const oldEntry = await getCached(oldKey);
    assert.ok(oldEntry, 'the actual legacy IndexedDB record must exist before testing admission');
    const cachedBytes = oldEntry.buffer instanceof Blob ? await oldEntry.buffer.arrayBuffer() : oldEntry.buffer;
    const cached = await new BinaryCacheReader().read(cachedBytes);
    assertRestoredSourceIndex(cached, bytes, [1, 2, 3, 21, 22, 31]);
    const currentKey = buildGeometryCacheKey(bytes.byteLength, fingerprint, false);
    assert.equal(await getCached(currentKey), null, 'current lookup must miss the old output policy');
    const reparsed = await parse(bytes);
    assert.equal(reparsed.malformedRecordCount, 1);
    assert.equal(reparsed.entityIndex.byId.has(22), true);
    await assert.rejects(new BinaryCacheWriter().write(toCacheDataStore(reparsed), undefined, bytes), /source index incomplete/);
    assert.ok(await getCached(oldKey), 'revision misses preserve the original record rather than deleting user evidence');
  });

  it('admits and reads a valid current doubled-quote cache under the normal key', async () => {
    const bytes = new TextEncoder().encode(text.replace("it's", "it''s").replace("Bob's", "Bob''s")).buffer;
    const store = await parse(bytes);
    assert.equal(store.malformedRecordCount, 0);
    const payload = await new BinaryCacheWriter().write(toCacheDataStore(store), undefined, bytes, { includeGeometry: false });
    const key = buildGeometryCacheKey(bytes.byteLength, computeSourceFingerprint(bytes).hex, false);
    await setCached(key, payload, 'valid.ifc', bytes.byteLength, bytes, { lastModified: 1 });
    const entry = await getCached(key);
    assert.ok(entry);
    const cached = await new BinaryCacheReader().read(entry.buffer instanceof Blob ? await entry.buffer.arrayBuffer() : entry.buffer);
    assertRestoredSourceIndex(cached, bytes, [1, 2, 3, 20, 21, 22, 30, 31]);
  });
});
