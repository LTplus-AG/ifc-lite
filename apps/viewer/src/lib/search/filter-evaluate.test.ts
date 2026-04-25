/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules, evaluateFilterRulesFederated, __internal } from './filter-evaluate.js';
import { Rule } from './filter-rules.js';

interface Row {
  expressId: number;
  type: string;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
}

function buildStore(rows: Row[]): IfcDataStore {
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
  // Populate byType so the prefilter has something to chew on. STEP
  // type names are stored UPPERCASE in this index — match the parser.
  const byType = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.type.toUpperCase();
    let bucket = byType.get(key);
    if (!bucket) { bucket = []; byType.set(key, bucket); }
    bucket.push(r.expressId);
  }
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: rows.length,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType },
    strings,
    entities,
    properties: { count: 0 },
    quantities: { count: 0 },
    relationships: { count: 0 },
  } as unknown as IfcDataStore;
}

const rows: Row[] = [
  { expressId: 10, type: 'IFCWALL',   globalId: '1abcdefghijklmnopqrstu', name: 'Wall-EXT-001' },
  { expressId: 20, type: 'IFCWALL',   globalId: '2abcdefghijklmnopqrstu', name: 'Wall-INT-002' },
  { expressId: 30, type: 'IFCDOOR',   globalId: '3abcdefghijklmnopqrstu', name: 'Door-A-201' },
  { expressId: 40, type: 'IFCSLAB',   globalId: '4abcdefghijklmnopqrstu', name: 'Slab-G-1' },
];

describe('evaluateFilterRules — column-only rules', () => {
  it('IfcType IN narrows to walls', () => {
    const store = buildStore(rows);
    const out = evaluateFilterRules('m1', store, [Rule.ifcType(['IfcWall'])], 'AND');
    assert.deepStrictEqual(out.map((r) => r.expressId).sort(), [10, 20]);
  });

  it('IfcType NOT IN excludes walls', () => {
    const store = buildStore(rows);
    const out = evaluateFilterRules('m1', store, [Rule.ifcType(['IfcWall'], 'notIn')], 'AND');
    assert.deepStrictEqual(out.map((r) => r.expressId).sort(), [30, 40]);
  });

  it('Name contains is case-insensitive', () => {
    const store = buildStore(rows);
    const out = evaluateFilterRules('m1', store, [Rule.name('contains', 'EXT')], 'AND');
    assert.deepStrictEqual(out.map((r) => r.expressId), [10]);
  });

  it('AND combinator narrows; OR widens', () => {
    const store = buildStore(rows);
    const andOut = evaluateFilterRules('m1', store, [
      Rule.ifcType(['IfcWall']),
      Rule.name('contains', 'EXT'),
    ], 'AND');
    assert.deepStrictEqual(andOut.map((r) => r.expressId), [10]);

    const orOut = evaluateFilterRules('m1', store, [
      Rule.ifcType(['IfcDoor']),
      Rule.name('contains', 'EXT'),
    ], 'OR');
    assert.deepStrictEqual(orOut.map((r) => r.expressId).sort(), [10, 30]);
  });

  it('respects candidateExpressIds (Tier-1 narrowing)', () => {
    const store = buildStore(rows);
    const out = evaluateFilterRules('m1', store, [Rule.ifcType(['IfcWall'])], 'AND', {
      candidateExpressIds: [20, 30, 40],
    });
    assert.deepStrictEqual(out.map((r) => r.expressId), [20]);
  });

  it('honours the limit option', () => {
    const store = buildStore(rows);
    const out = evaluateFilterRules('m1', store, [Rule.ifcType(['IfcWall'])], 'AND', { limit: 1 });
    assert.strictEqual(out.length, 1);
  });

  it('returns matching elements with model id and ifc type populated', () => {
    const store = buildStore(rows);
    const out = evaluateFilterRules('m1', store, [Rule.name('eq', 'Door-A-201')], 'AND');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].modelId, 'm1');
    assert.strictEqual(out[0].ifcType, 'IfcDoor');
    assert.strictEqual(out[0].globalId, '3abcdefghijklmnopqrstu');
  });
});

describe('evaluateFilterRules — storey & predefinedType resolvers', () => {
  it('uses storeyNameOf when provided', () => {
    const store = buildStore(rows);
    const storeyByExpressId = new Map([[10, 'Level 1'], [20, 'Level 2'], [30, 'Level 1']]);
    const out = evaluateFilterRules('m1', store, [Rule.storey(['Level 1'])], 'AND', {
      storeyNameOf: (id) => storeyByExpressId.get(id) ?? '',
    });
    assert.deepStrictEqual(out.map((r) => r.expressId).sort(), [10, 30]);
  });

  it('uses predefinedTypeOf when provided', () => {
    const store = buildStore(rows);
    const ptByExpressId = new Map([[10, 'SOLIDWALL'], [20, 'PARTITIONING'], [30, 'DOOR']]);
    const out = evaluateFilterRules('m1', store, [
      Rule.predefinedType(['SOLIDWALL']),
    ], 'AND', { predefinedTypeOf: (id) => ptByExpressId.get(id) ?? '' });
    assert.deepStrictEqual(out.map((r) => r.expressId), [10]);
  });
});

describe('evaluateFilterRulesFederated', () => {
  it('merges results from multiple models', async () => {
    const a = buildStore(rows);
    const b = buildStore([
      { expressId: 100, type: 'IFCWALL', globalId: 'aabcdefghijklmnopqrstu', name: 'Wall-B-1' },
    ]);
    const out = await evaluateFilterRulesFederated(
      [{ id: 'a', store: a }, { id: 'b', store: b }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
    );
    assert.strictEqual(out.length, 3);
    const modelIds = new Set(out.map((r) => r.modelId));
    assert.deepStrictEqual([...modelIds].sort(), ['a', 'b']);
  });

  it('caps total across federated models', async () => {
    const a = buildStore(rows);
    const b = buildStore(rows.map((r) => ({ ...r, expressId: r.expressId + 1000 })));
    const out = await evaluateFilterRulesFederated(
      [{ id: 'a', store: a }, { id: 'b', store: b }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
      { limit: 3 },
    );
    assert.strictEqual(out.length, 3);
  });
});

describe('flattenPsets / matchPropertyRule', () => {
  it('stringifies booleans and numbers consistently', () => {
    const flat = __internal.flattenPsets([
      {
        name: 'Pset_WallCommon',
        properties: [
          { name: 'IsExternal', type: 0, value: true },
          { name: 'ThermalTransmittance', type: 0, value: 0.24 },
          { name: 'Reference', type: 0, value: 'EXT-A' },
          { name: 'Empty', type: 0, value: null },
        ],
      },
    ]);
    assert.deepStrictEqual(flat.map((r) => r.value), ['true', '0.24', 'EXT-A', '']);
  });

  it('matches isSet / isNotSet by (set, prop) presence only', () => {
    const flat = __internal.flattenPsets([
      { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', type: 0, value: true }] },
    ]);
    assert.strictEqual(
      __internal.matchPropertyRule(Rule.property('Pset_WallCommon', 'IsExternal', 'isSet', ''), flat),
      true,
    );
    assert.strictEqual(
      __internal.matchPropertyRule(Rule.property('Pset_WallCommon', 'Missing', 'isSet', ''), flat),
      false,
    );
    assert.strictEqual(
      __internal.matchPropertyRule(Rule.property('Pset_WallCommon', 'Missing', 'isNotSet', ''), flat),
      true,
    );
  });

  it('contains is case-insensitive over the stringified value', () => {
    const flat = __internal.flattenPsets([
      { name: 'Pset_WallCommon', properties: [{ name: 'Reference', type: 0, value: 'WALL-EXT-A' }] },
    ]);
    assert.strictEqual(
      __internal.matchPropertyRule(
        Rule.property('Pset_WallCommon', 'Reference', 'contains', 'ext'),
        flat,
      ),
      true,
    );
  });

  it('numeric value ops parse both sides; NaN fails closed', () => {
    const flat = __internal.flattenPsets([
      { name: 'Pset_WallCommon', properties: [{ name: 'U', type: 0, value: 0.24 }] },
    ]);
    assert.strictEqual(
      __internal.matchPropertyRule(Rule.property('Pset_WallCommon', 'U', 'lt', '0.3'), flat),
      true,
    );
    assert.strictEqual(
      __internal.matchPropertyRule(Rule.property('Pset_WallCommon', 'U', 'gt', 'abc'), flat),
      false,
    );
  });
});

describe('matchQuantityRule', () => {
  it('matches by (set, qty) with numeric op', () => {
    const flat = __internal.flattenQtys([
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetSideArea', type: 0, value: 12.5 }] },
    ]);
    assert.strictEqual(
      __internal.matchQuantityRule(
        Rule.quantity('Qto_WallBaseQuantities', 'NetSideArea', 'gt', 10),
        flat,
      ),
      true,
    );
    assert.strictEqual(
      __internal.matchQuantityRule(
        Rule.quantity('Qto_WallBaseQuantities', 'Missing', 'gt', 10),
        flat,
      ),
      false,
    );
  });
});

describe('evaluateFilterRulesFederated — per-model candidate narrowing', () => {
  it('candidateExpressIdsByModel narrows each model independently', async () => {
    const a = buildStore(rows);
    const b = buildStore([
      { expressId: 100, type: 'IFCWALL', globalId: 'aabcdefghijklmnopqrstu', name: 'Wall-B-1' },
      { expressId: 101, type: 'IFCDOOR', globalId: 'babcdefghijklmnopqrstu', name: 'Door-B-2' },
    ]);
    const candidatesByModel = new Map<string, Iterable<number>>([
      ['a', [10]],     // only Wall-EXT-001 from a
      ['b', [101]],    // only Door-B-2 from b
    ]);
    const out = await evaluateFilterRulesFederated(
      [{ id: 'a', store: a }, { id: 'b', store: b }],
      [Rule.ifcType(['IfcWall', 'IfcDoor'])],
      'AND',
      { candidateExpressIdsByModel: candidatesByModel },
    );
    // Two narrow hits — one wall from `a`, one door from `b`.
    assert.deepStrictEqual(
      out.map((r) => `${r.modelId}:${r.expressId}`).sort(),
      ['a:10', 'b:101'],
    );
  });

  it('an empty candidate set for a model yields zero results from that model (intersection semantics)', async () => {
    // Codex P1 invariant: a misspelt text query that produced zero
    // Tier-0/Tier-1 hits must NOT degrade to a full-table scan when
    // the user has structured rules. Empty Iterable per model ⇒ no rows.
    const a = buildStore(rows);
    const candidatesByModel = new Map<string, Iterable<number>>([['a', []]]);
    const out = await evaluateFilterRulesFederated(
      [{ id: 'a', store: a }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
      { candidateExpressIdsByModel: candidatesByModel },
    );
    assert.deepStrictEqual(out, []);
  });

  it('omitting the map keeps the legacy full-scan behaviour', async () => {
    const a = buildStore(rows);
    const out = await evaluateFilterRulesFederated(
      [{ id: 'a', store: a }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
    );
    assert.deepStrictEqual(out.map((r) => r.expressId).sort(), [10, 20]);
  });

  it('storeyNameOf / predefinedTypeOf flow through the federated wrapper', async () => {
    const a = buildStore(rows);
    const out = await evaluateFilterRulesFederated(
      [{ id: 'a', store: a }],
      [Rule.storey(['Level 1'])],
      'AND',
      { storeyNameOf: (id) => (id === 10 ? 'Level 1' : '') },
    );
    assert.deepStrictEqual(out.map((r) => r.expressId), [10]);
  });
});

describe('evaluateFilterRules — empty rules', () => {
  it('returns [] when rules is empty (matches Rust behaviour)', () => {
    const store = buildStore(rows);
    assert.deepStrictEqual(evaluateFilterRules('m1', store, [], 'AND'), []);
  });
});

describe('orderRulesByCost — cheap-first reordering', () => {
  const order = __internal.orderRulesByCost;

  it('lifts cheap kinds (ifcType, name, storey) before expensive (property, quantity)', () => {
    const reordered = order([
      Rule.property('Pset_X', 'P', 'eq', 'v'),
      Rule.ifcType(['IfcWall']),
      Rule.quantity('Qto_X', 'Q', 'gt', 1),
      Rule.name('contains', 'wall'),
    ]);
    // Equal-cost rules retain their authored order — `ifcType` before
    // `name` because cost(ifcType)=0 < cost(name)=2.
    assert.deepStrictEqual(reordered.map((r) => r.kind), ['ifcType', 'name', 'property', 'quantity']);
  });

  it('is a stable sort — two equal-cost rules keep their input order', () => {
    const a = Rule.name('contains', 'a');
    const b = Rule.name('contains', 'b');
    const reordered = order([a, b]);
    assert.strictEqual(reordered[0], a);
    assert.strictEqual(reordered[1], b);
  });

  it('does not mutate the input array', () => {
    const input = [
      Rule.property('Pset_X', 'P', 'eq', 'v'),
      Rule.ifcType(['IfcWall']),
    ];
    const before = input.map((r) => r.kind);
    void order(input);
    assert.deepStrictEqual(input.map((r) => r.kind), before);
  });
});

describe('selectIterationSource — index prefilter (AND + op:in)', () => {
  const select = __internal.selectIterationSource;

  it('AND + ifcType op:in narrows to byType bucket(s)', () => {
    const store = buildStore(rows);
    const source = select(store, [Rule.ifcType(['IfcWall'])], 'AND', undefined);
    const ids = Array.from(source as Iterable<number>);
    // Bucket holds only the two walls — not the door / slab.
    assert.deepStrictEqual(ids.sort(), [10, 20]);
  });

  it('AND + multiple narrowing rules picks the smallest bucket', () => {
    const store = buildStore(rows);
    // ifcType {IfcWall} = 2 entries; ifcType {IfcDoor} = 1 entry.
    // The smaller of the two should be chosen as the iteration source.
    const source = select(
      store,
      [Rule.ifcType(['IfcWall']), Rule.ifcType(['IfcDoor'])],
      'AND',
      undefined,
    );
    const ids = Array.from(source as Iterable<number>);
    assert.deepStrictEqual(ids, [30]);
  });

  it('OR combinator skips the prefilter and falls back to the full table', () => {
    const store = buildStore(rows);
    const source = select(store, [Rule.ifcType(['IfcWall'])], 'OR', undefined);
    const ids = Array.from(source as Iterable<number>);
    // Generator over the full expressId column — all four entities.
    assert.deepStrictEqual(ids.sort(), [10, 20, 30, 40]);
  });

  it('notIn ops skip the prefilter (inverting a small set is still big)', () => {
    const store = buildStore(rows);
    const source = select(store, [Rule.ifcType(['IfcWall'], 'notIn')], 'AND', undefined);
    const ids = Array.from(source as Iterable<number>);
    // No bucket suggested → full-table iteration.
    assert.strictEqual(ids.length, 4);
  });

  it('explicit candidateExpressIds wins over the prefilter', () => {
    const store = buildStore(rows);
    const source = select(store, [Rule.ifcType(['IfcWall'])], 'AND', [99]);
    assert.deepStrictEqual(Array.from(source as Iterable<number>), [99]);
  });
});

describe('evaluateFilterRulesFederated — large-model scaling', () => {
  // Synthetic 50K-entity store: 200 walls in a sea of slabs. The
  // prefilter MUST narrow the scan to the wall bucket (≤ 200 entities)
  // rather than walking the full table — otherwise huge models would
  // freeze the main thread on Fast Run, which is the AGENTS.md §2 trap
  // this whole module is built to avoid.
  it('AND + ifcType prefilter scans only the bucket on a 50K-entity model', async () => {
    const big: Row[] = [];
    for (let i = 0; i < 50_000; i++) {
      big.push({
        expressId: i + 1,
        type: i % 250 === 0 ? 'IFCWALL' : 'IFCSLAB',
        globalId: `${String(i).padStart(22, '0')}`.slice(0, 22),
        name: `entity-${i}`,
      });
    }
    const store = buildStore(big);
    let lastTotal = 0;
    const out = await evaluateFilterRulesFederated(
      [{ id: 'm', store }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
      {
        chunkSize: 1_000,
        onProgress: (_scanned, total) => { lastTotal = total; },
      },
    );
    // 50_000 / 250 = 200 walls.
    assert.strictEqual(out.length, 200);
    // Progress total is the SCAN size (the bucket, not the full table).
    // Without the prefilter this would have been 50_000.
    assert.strictEqual(lastTotal, 200);
  });

  it('OR mode falls back to full scan (prefilter is unsafe under OR)', async () => {
    const big: Row[] = [];
    for (let i = 0; i < 1_000; i++) {
      big.push({
        expressId: i + 1,
        type: i % 100 === 0 ? 'IFCWALL' : 'IFCSLAB',
        globalId: `${String(i).padStart(22, '0')}`.slice(0, 22),
        name: i === 0 ? 'special' : `entity-${i}`,
      });
    }
    const store = buildStore(big);
    let lastTotal = 0;
    const out = await evaluateFilterRulesFederated(
      [{ id: 'm', store }],
      [Rule.ifcType(['IfcWall']), Rule.name('eq', 'special')],
      'OR',
      {
        chunkSize: 100,
        onProgress: (_scanned, total) => { lastTotal = total; },
      },
    );
    // 10 walls + 1 special = 10 results (the 'special' wall is also in
    // the wall bucket, so it counts once via dedupe of the OR — but
    // the evaluator doesn't dedupe; it just scans, which produces 10
    // hits since 'special' IS one of the walls). Either way the test
    // verifies OR scans the full table.
    assert.strictEqual(out.length, 10);
    assert.strictEqual(lastTotal, 1_000);
  });
});

describe('evaluateFilterRulesFederated — async chunking, abort, progress', () => {
  it('reports onProgress with monotonically growing scanned counter', async () => {
    const store = buildStore(rows);
    const ticks: Array<{ scanned: number; total: number }> = [];
    await evaluateFilterRulesFederated(
      [{ id: 'm', store }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
      {
        chunkSize: 1,
        onProgress: (scanned, total) => { ticks.push({ scanned, total }); },
      },
    );
    // First tick is the initial 0/total emission; subsequent ticks
    // monotonically grow; final tick equals total.
    assert.ok(ticks.length >= 2, `expected ≥2 progress ticks, got ${ticks.length}`);
    assert.strictEqual(ticks[0].scanned, 0);
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(
        ticks[i].scanned >= ticks[i - 1].scanned,
        `progress regressed from ${ticks[i - 1].scanned} → ${ticks[i].scanned}`,
      );
    }
  });

  it('honours AbortSignal at chunk boundaries', async () => {
    const store = buildStore(rows);
    const controller = new AbortController();
    // Abort before the first await — the evaluator's chunk-boundary
    // check fires after the first chunk completes.
    controller.abort();
    let threwAbort = false;
    try {
      await evaluateFilterRulesFederated(
        [{ id: 'm', store }],
        [Rule.ifcType(['IfcWall'])],
        'AND',
        { chunkSize: 1, signal: controller.signal },
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') threwAbort = true;
      else throw err;
    }
    assert.ok(threwAbort, 'expected AbortError when signal is pre-aborted');
  });

  it('limit short-circuits the run before scanning the rest', async () => {
    const store = buildStore(rows);
    let lastScanned = 0;
    const out = await evaluateFilterRulesFederated(
      [{ id: 'm', store }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
      {
        limit: 1,
        chunkSize: 1,
        onProgress: (scanned) => { lastScanned = scanned; },
      },
    );
    assert.strictEqual(out.length, 1);
    // We should have stopped before scanning all four entities.
    assert.ok(lastScanned < rows.length, `expected early termination, scanned ${lastScanned}`);
  });
});
