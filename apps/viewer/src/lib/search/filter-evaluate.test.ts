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
  it('merges results from multiple models', () => {
    const a = buildStore(rows);
    const b = buildStore([
      { expressId: 100, type: 'IFCWALL', globalId: 'aabcdefghijklmnopqrstu', name: 'Wall-B-1' },
    ]);
    const out = evaluateFilterRulesFederated(
      [{ id: 'a', store: a }, { id: 'b', store: b }],
      [Rule.ifcType(['IfcWall'])],
      'AND',
    );
    assert.strictEqual(out.length, 3);
    const modelIds = new Set(out.map((r) => r.modelId));
    assert.deepStrictEqual([...modelIds].sort(), ['a', 'b']);
  });

  it('caps total across federated models', () => {
    const a = buildStore(rows);
    const b = buildStore(rows.map((r) => ({ ...r, expressId: r.expressId + 1000 })));
    const out = evaluateFilterRulesFederated(
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

describe('evaluateFilterRules — empty rules', () => {
  it('returns [] when rules is empty (matches Rust behaviour)', () => {
    const store = buildStore(rows);
    assert.deepStrictEqual(evaluateFilterRules('m1', store, [], 'AND'), []);
  });
});
