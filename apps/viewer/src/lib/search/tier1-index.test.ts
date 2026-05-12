/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  buildTier1Index,
  queryTier1Indexes,
  __internal,
  type Tier1Index,
} from './tier1-index.js';

function buildStore(rows: Array<{
  expressId: number;
  type: string;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
}>): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(rows.length, strings);
  for (const r of rows) {
    builder.add(
      r.expressId,
      r.type,
      r.globalId,
      r.name,
      r.description ?? '',
      r.objectType ?? '',
      false,
      false,
    );
  }
  const entities = builder.build();
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: rows.length,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType: new Map() },
    strings,
    entities,
    properties: { count: 0 },
    quantities: { count: 0 },
    relationships: { count: 0 },
  } as unknown as IfcDataStore;
}

const baseRows = [
  { expressId: 10, type: 'IFCWALL', globalId: '1abcdefghijklmnopqrstu', name: 'Wall-EXT-001' },
  { expressId: 20, type: 'IFCWALL', globalId: '2abcdefghijklmnopqrstu', name: 'Wall-INT-002' },
  { expressId: 30, type: 'IFCDOOR', globalId: '3abcdefghijklmnopqrstu', name: 'Door-A-201' },
  { expressId: 40, type: 'IFCWINDOW', globalId: '4abcdefghijklmnopqrstu', name: 'WIN-North-1', description: 'fire-rated' },
  { expressId: 50, type: 'IFCSLAB', globalId: '5abcdefghijklmnopqrstu', name: '', objectType: 'SLAB-FLOOR' },
  { expressId: 60, type: 'IFCWALL', globalId: '', name: '' }, // all-empty, should be skipped
];

describe('tokenize', () => {
  it('splits on whitespace and IFC punctuation', () => {
    assert.deepStrictEqual(__internal.tokenize('Wall-EXT-001'), ['wall', 'ext', '001']);
    assert.deepStrictEqual(__internal.tokenize('Pset_WallCommon'), ['pset', 'wallcommon']);
    assert.deepStrictEqual(__internal.tokenize('Level.01/Zone:A'), ['level', '01', 'zone']);
  });

  it('strips one-char non-digit tokens but keeps digits', () => {
    assert.deepStrictEqual(__internal.tokenize('a b c 2'), ['2']);
    assert.deepStrictEqual(__internal.tokenize('X-2-Y'), ['2']);
  });

  it('returns empty on empty input', () => {
    assert.deepStrictEqual(__internal.tokenize(''), []);
  });
});

describe('prefixRange', () => {
  const tokens = ['apple', 'apricot', 'banana', 'blueberry', 'cherry'];
  it('returns the [lo, hi) range of tokens matching the prefix', () => {
    assert.deepStrictEqual(__internal.prefixRange(tokens, 'ap'), [0, 2]);
    assert.deepStrictEqual(__internal.prefixRange(tokens, 'b'), [2, 4]);
    assert.deepStrictEqual(__internal.prefixRange(tokens, 'cherry'), [4, 5]);
  });
  it('returns an empty range when the prefix does not match', () => {
    const [lo, hi] = __internal.prefixRange(tokens, 'z');
    assert.strictEqual(lo, hi);
  });
});

describe('buildTier1Index', () => {
  it('populates entries for non-empty rows and skips the all-empty row', async () => {
    const store = buildStore(baseRows);
    const idx = await buildTier1Index('m', store);
    assert.strictEqual(idx.modelId, 'm');
    assert.strictEqual(idx.sourceEntityCount, baseRows.length);
    // Six rows in but row 60 is all-empty → 5 entries.
    assert.strictEqual(idx.entries.length, 5);
    assert.ok(idx.entries.every((e) => e.expressId !== 60));
  });

  it('tokenizes names, types, descriptions, and objectTypes into the token index', async () => {
    const store = buildStore(baseRows);
    const idx = await buildTier1Index('m', store);
    assert.ok(idx.tokenIndex.has('wall'), 'type token "wall" is present');
    assert.ok(idx.tokenIndex.has('ext'), 'name token "ext" is present');
    assert.ok(idx.tokenIndex.has('fire'), 'description token "fire" is present');
    assert.ok(idx.tokenIndex.has('slab'), 'objectType token "slab" is present');
    // GUIDs are intentionally NOT tokenized.
    assert.ok(!idx.tokenIndex.has('1abcdefghijklmnopqrstu'));
  });

  it('builds a case-sensitive globalIdMap for O(1) exact GUID lookup', async () => {
    const store = buildStore(baseRows);
    const idx = await buildTier1Index('m', store);
    assert.strictEqual(idx.globalIdMap.size, 5);
    assert.ok(idx.globalIdMap.has('3abcdefghijklmnopqrstu'));
    // Empty GUIDs don't land in the map.
    assert.ok(!idx.globalIdMap.has(''));
  });

  it('supports AbortSignal cancellation between chunks', async () => {
    const manyRows = Array.from({ length: 500 }, (_, i) => ({
      expressId: 1000 + i,
      type: 'IFCWALL',
      globalId: `g${String(i).padStart(21, 'x')}`,
      name: `Wall-${i}`,
    }));
    const store = buildStore(manyRows);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => buildTier1Index('m', store, { signal: controller.signal, chunkSize: 50 }),
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );
  });

  it('invokes the onProgress callback after each chunk', async () => {
    const manyRows = Array.from({ length: 250 }, (_, i) => ({
      expressId: 1000 + i,
      type: 'IFCWALL',
      globalId: `g${String(i).padStart(21, 'x')}`,
      name: `Wall-${i}`,
    }));
    const store = buildStore(manyRows);
    const progressValues: Array<{ done: number; total: number }> = [];
    await buildTier1Index('m', store, {
      chunkSize: 50,
      onProgress: (done, total) => progressValues.push({ done, total }),
    });
    assert.ok(progressValues.length >= 5, 'at least one progress call per chunk');
    assert.strictEqual(progressValues[progressValues.length - 1].done, 250);
    assert.strictEqual(progressValues[progressValues.length - 1].total, 250);
  });
});

describe('queryTier1Indexes', () => {
  const makeIndex = async (id: string, rows: typeof baseRows): Promise<Tier1Index> => {
    return buildTier1Index(id, buildStore(rows));
  };

  it('returns nothing for empty queries', async () => {
    const idx = await makeIndex('m', baseRows);
    assert.deepStrictEqual(queryTier1Indexes([idx], ''), []);
    assert.deepStrictEqual(queryTier1Indexes([idx], '   '), []);
  });

  it('exact GUID match takes the fast path with highest score', async () => {
    const idx = await makeIndex('m', baseRows);
    const results = queryTier1Indexes([idx], '3abcdefghijklmnopqrstu');
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].expressId, 30);
    assert.strictEqual(results[0].matchField, 'globalId');
    assert.ok(results[0].score >= 1000);
  });

  it('matches by exact token with correct scoring precedence', async () => {
    const idx = await makeIndex('m', baseRows);
    const results = queryTier1Indexes([idx], 'wall');
    // Three walls: two named Wall-EXT/Wall-INT (IFCWALL) AND the all-empty
    // IFCWALL row is skipped → two results.
    const ids = results.map((r) => r.expressId).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [10, 20]);
  });

  it('prefix-expands single tokens ("wal" surfaces "wall")', async () => {
    const idx = await makeIndex('m', baseRows);
    const results = queryTier1Indexes([idx], 'wal');
    const ids = results.map((r) => r.expressId).sort((a, b) => a - b);
    // Should include both walls via prefix expansion.
    assert.ok(ids.includes(10));
    assert.ok(ids.includes(20));
  });

  it('matches by IFC type', async () => {
    const idx = await makeIndex('m', baseRows);
    const results = queryTier1Indexes([idx], 'ifcdoor');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].expressId, 30);
    assert.strictEqual(results[0].matchField, 'type');
  });

  it('matches description / objectType substrings even with no token hit', async () => {
    const idx = await makeIndex('m', baseRows);
    const desc = queryTier1Indexes([idx], 'fire-rated');
    assert.ok(desc.some((r) => r.expressId === 40 && r.matchField === 'description'));

    const obj = queryTier1Indexes([idx], 'slab-floor');
    assert.ok(obj.some((r) => r.expressId === 50 && r.matchField === 'objectType'));
  });

  it('respects the result limit and orders by descending score', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      expressId: 100 + i,
      type: 'IFCWALL',
      globalId: `g${String(i).padStart(21, 'x')}`,
      name: i === 0 ? 'wall' : `wall-${i}`,
    }));
    const idx = await buildTier1Index('m', buildStore(many));
    const results = queryTier1Indexes([idx], 'wall', { limit: 5 });
    assert.strictEqual(results.length, 5);
    // Exact-match "wall" row outranks the prefix/token-only siblings.
    assert.strictEqual(results[0].name, 'wall');
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score);
    }
  });

  it('merges results across multiple federated indexes and dedupes', async () => {
    const a = await buildTier1Index('A', buildStore([
      { expressId: 1, type: 'IFCWALL', globalId: 'aaaaaaaaaaaaaaaaaaaaaa', name: 'Lobby-Wall' },
    ]));
    const b = await buildTier1Index('B', buildStore([
      { expressId: 2, type: 'IFCWALL', globalId: 'bbbbbbbbbbbbbbbbbbbbbb', name: 'Tower-Wall' },
    ]));
    const results = queryTier1Indexes([a, b], 'wall');
    const tagged = results.map((r) => `${r.modelId}:${r.expressId}`).sort();
    assert.deepStrictEqual(tagged, ['A:1', 'B:2']);
  });
});
