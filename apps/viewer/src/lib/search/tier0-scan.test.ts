/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { runTier0Scan, type ScanModel } from './tier0-scan.js';

/**
 * Build a minimal IfcDataStore-shaped object whose `entities` table is real
 * (via @ifc-lite/data EntityTableBuilder) and whose remaining slots are the
 * smallest stubs the scanner accepts. Tier-0 only touches `entities` +
 * `strings`; everything else can be empty.
 */
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

  const store = {
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

  return store;
}

function modelOf(id: string, store: IfcDataStore): ScanModel {
  return { id, ifcDataStore: store };
}

describe('runTier0Scan', () => {
  const baseRows = [
    { expressId: 10, type: 'IFCWALL', globalId: '1abcdefghijklmnopqrstu', name: 'Wall-EXT-001' },
    { expressId: 20, type: 'IFCWALL', globalId: '2abcdefghijklmnopqrstu', name: 'Wall-INT-002' },
    { expressId: 30, type: 'IFCDOOR', globalId: '3abcdefghijklmnopqrstu', name: 'Door-A-201' },
    { expressId: 40, type: 'IFCWINDOW', globalId: '4abcdefghijklmnopqrstu', name: 'WIN-North-1', description: 'fire-rated' },
    { expressId: 50, type: 'IFCSLAB', globalId: '5abcdefghijklmnopqrstu', name: '', objectType: 'SLAB-FLOOR' },
  ];

  it('returns nothing for empty/whitespace queries', () => {
    const store = buildStore(baseRows);
    assert.deepStrictEqual(runTier0Scan([modelOf('m', store)], ''), []);
    assert.deepStrictEqual(runTier0Scan([modelOf('m', store)], '   '), []);
  });

  it('handles models with no IfcDataStore', () => {
    const results = runTier0Scan([{ id: 'm', ifcDataStore: null }], 'wall');
    assert.deepStrictEqual(results, []);
  });

  it('matches by name substring (case-insensitive)', () => {
    const store = buildStore(baseRows);
    const results = runTier0Scan([modelOf('m', store)], 'wall');
    const ids = results.map((r) => r.expressId).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [10, 20]);
    for (const r of results) {
      assert.strictEqual(r.matchField, 'name');
    }
  });

  it('exact GUID match wins (highest score, GUID fast path)', () => {
    const store = buildStore(baseRows);
    const results = runTier0Scan([modelOf('m', store)], '3abcdefghijklmnopqrstu');
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].expressId, 30);
    assert.strictEqual(results[0].matchField, 'globalId');
    // GUID exact (1000) should outrank everything else.
    assert.ok(results[0].score >= 1000);
  });

  it('GUID fast path does not double-emit a row that the linear scan also returns', () => {
    const store = buildStore(baseRows);
    const results = runTier0Scan([modelOf('m', store)], '3abcdefghijklmnopqrstu');
    const seen = new Set<string>();
    for (const r of results) {
      const key = `${r.modelId}:${r.expressId}`;
      assert.ok(!seen.has(key), `duplicate row for ${key}`);
      seen.add(key);
    }
  });

  it('matches by IFC type prefix and exact', () => {
    const store = buildStore(baseRows);
    const exact = runTier0Scan([modelOf('m', store)], 'ifcwall');
    // Two walls match by type.
    assert.strictEqual(exact.filter((r) => r.matchField === 'type').length, 2);

    const prefix = runTier0Scan([modelOf('m', store)], 'ifcwin');
    const winner = prefix.find((r) => r.expressId === 40);
    assert.ok(winner);
    assert.strictEqual(winner!.matchField, 'type');
  });

  it('keeps the MAX score across fields (a substring name hit can be outranked by a type-exact hit)', () => {
    // The entity's name contains "wall" (NAME_SUBSTR=40) AND its type
    // is exactly "IfcWall" (TYPE_EXACT=80). The match should win on
    // type, not be capped at name. Without this, multi-model results
    // where one model used Tier-1 (max-across-fields) and another
    // used Tier-0 (short-circuit) would rank the same logical match
    // differently — breaking the comparable-ordering guarantee.
    const store = buildStore([
      { expressId: 10, type: 'IFCWALL', globalId: '1abcdefghijklmnopqrstu', name: 'metal-wall-cladding' },
    ]);
    const out = runTier0Scan([modelOf('m', store)], 'ifcwall');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].matchField, 'type', 'type should outrank a substring name hit');
    // 80 (TYPE_EXACT) ≫ 40 (NAME_SUBSTR).
    assert.strictEqual(out[0].score, 80);
  });

  it('matches by description and objectType when name/type miss', () => {
    const store = buildStore(baseRows);

    const desc = runTier0Scan([modelOf('m', store)], 'fire-rated');
    assert.strictEqual(desc.length, 1);
    assert.strictEqual(desc[0].expressId, 40);
    assert.strictEqual(desc[0].matchField, 'description');

    const obj = runTier0Scan([modelOf('m', store)], 'slab-floor');
    assert.strictEqual(obj.length, 1);
    assert.strictEqual(obj[0].expressId, 50);
    assert.strictEqual(obj[0].matchField, 'objectType');
  });

  it('respects the result limit and orders by descending score', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      expressId: 100 + i,
      type: 'IFCWALL',
      globalId: `g${String(i).padStart(21, 'x')}`,
      name: i === 0 ? 'wall' : `wall-${i}`,
    }));
    const store = buildStore(many);
    const results = runTier0Scan([modelOf('m', store)], 'wall', { limit: 5 });
    assert.strictEqual(results.length, 5);
    // Exact-match row 'wall' must come first (NAME_EXACT > NAME_PREFIX).
    assert.strictEqual(results[0].name, 'wall');
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, 'score must be non-increasing');
    }
  });

  it('searches across multiple federated models and tags results with modelId', () => {
    const a = buildStore([
      { expressId: 1, type: 'IFCWALL', globalId: 'aaaaaaaaaaaaaaaaaaaaaa', name: 'Lobby-Wall' },
    ]);
    const b = buildStore([
      { expressId: 2, type: 'IFCWALL', globalId: 'bbbbbbbbbbbbbbbbbbbbbb', name: 'Tower-Wall' },
    ]);
    const results = runTier0Scan([modelOf('A', a), modelOf('B', b)], 'wall');
    const tagged = results.map((r) => `${r.modelId}:${r.expressId}`).sort();
    assert.deepStrictEqual(tagged, ['A:1', 'B:2']);
  });

  it('skips rows where every searchable string slot is empty (perf shortcut)', () => {
    // Row 60 has no name/globalId/description/objectType — must NOT appear
    // in any text search (and must not crash the scanner).
    const rows = [
      ...baseRows,
      { expressId: 60, type: 'IFCWALL', globalId: '', name: '' },
    ];
    const store = buildStore(rows);
    const results = runTier0Scan([modelOf('m', store)], 'wall');
    assert.ok(!results.some((r) => r.expressId === 60));
  });
});
