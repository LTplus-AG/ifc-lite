/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ServerEntityIndex (issue #1841): the server data-model decoder must expose
 * entities as a compact columnar index — NOT a Map<number, EntityMetadata>,
 * which hits V8's 2^24 entry ceiling on huge models — while keeping a
 * Map-compatible read surface for existing consumers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ServerEntityIndex,
  type DataModel,
  type EntityMetadata,
} from '@ifc-lite/server-client';

// Compile-time guarantee: DataModel.entities IS a ServerEntityIndex (a plain
// Map<number, EntityMetadata> no longer typechecks as DataModel['entities']).
const _entitiesTypeIsServerEntityIndex: ServerEntityIndex =
  undefined as unknown as DataModel['entities'];
void _entitiesTypeIsServerEntityIndex;

const ROWS: EntityMetadata[] = [
  { entity_id: 5, type_name: 'IFCPROJECT', global_id: 'P', name: 'Proj', has_geometry: false },
  { entity_id: 12, type_name: 'IFCWALL', global_id: 'W1', name: 'Wall A', description: 'desc', object_type: 'Basic', tag: 'T-1', predefined_type: 'SOLIDWALL', has_geometry: true },
  { entity_id: 40, type_name: 'IFCWALL', global_id: 'W2', has_geometry: true },
];

describe('ServerEntityIndex', () => {
  it('is columnar, not a Map', () => {
    const index = ServerEntityIndex.fromRows(ROWS);
    assert.ok(index instanceof ServerEntityIndex);
    assert.ok(!(index instanceof Map));
    // Raw columns are exposed for indexed (columnar) consumption.
    assert.ok(index.columns.expressId instanceof Uint32Array);
    assert.ok(index.columns.hasGeometry instanceof Uint8Array);
    assert.equal(index.columns.count, 3);
    assert.deepEqual(Array.from(index.columns.expressId), [5, 12, 40]);
    assert.equal(index.columns.typeName[1], 'IFCWALL');
  });

  it('matches Map semantics for get/has/size/iteration', () => {
    const index = ServerEntityIndex.fromRows(ROWS);
    // Materialized rows always carry every EntityMetadata key (absent fields
    // are undefined), so normalize the reference rows to the full shape.
    const full = (r: EntityMetadata): EntityMetadata => ({
      entity_id: r.entity_id,
      type_name: r.type_name,
      global_id: r.global_id,
      name: r.name,
      description: r.description,
      object_type: r.object_type,
      tag: r.tag,
      predefined_type: r.predefined_type,
      has_geometry: r.has_geometry,
    });
    const reference = new Map<number, EntityMetadata>(ROWS.map((r) => [r.entity_id, full(r)]));

    assert.equal(index.size, reference.size);

    for (const [id, expected] of reference) {
      assert.ok(index.has(id));
      assert.deepEqual(index.get(id), expected);
    }
    assert.equal(index.get(999), undefined);
    assert.equal(index.has(999), false);
    assert.equal(index.get(0), undefined);

    // for (const [id, entity] of index) — Map-compatible tuple iteration.
    const iterated: Array<[number, EntityMetadata]> = [];
    for (const [id, entity] of index) iterated.push([id, entity]);
    assert.deepEqual(iterated, Array.from(reference));
    assert.deepEqual(Array.from(index.keys()), Array.from(reference.keys()));
    assert.deepEqual(Array.from(index.values()), Array.from(reference.values()));
    assert.deepEqual(Array.from(index.entries()), Array.from(reference.entries()));

    const seen: number[] = [];
    index.forEach((entity, id) => {
      assert.equal(entity.entity_id, id);
      seen.push(id);
    });
    assert.deepEqual(seen, [5, 12, 40]);
  });

  it('handles UNSORTED ids via the sorted binary-search view, preserving row order', () => {
    const rows: EntityMetadata[] = [
      { entity_id: 30, type_name: 'IFCDOOR', has_geometry: true },
      { entity_id: 10, type_name: 'IFCWALL', has_geometry: false },
      { entity_id: 20, type_name: 'IFCSLAB', has_geometry: true },
    ];
    const index = ServerEntityIndex.fromRows(rows);

    assert.equal(index.get(10)?.type_name, 'IFCWALL');
    assert.equal(index.get(20)?.type_name, 'IFCSLAB');
    assert.equal(index.get(30)?.type_name, 'IFCDOOR');
    assert.equal(index.get(15), undefined);

    // rowIndexOf returns positions in ORIGINAL row order (columnar consumers
    // rely on row == EntityTable index).
    assert.equal(index.rowIndexOf(30), 0);
    assert.equal(index.rowIndexOf(10), 1);
    assert.equal(index.rowIndexOf(20), 2);
    assert.equal(index.rowIndexOf(99), -1);

    // Iteration stays in emission (row) order, like the old Map insertion order.
    assert.deepEqual(Array.from(index.keys()), [30, 10, 20]);
  });

  it('materializes rows lazily from decoder-shaped columns (empty -> undefined)', () => {
    // Same column shapes decodeDataModel produces: typed arrays + string
    // arrays, optional v4 columns absent (older server payloads).
    const index = new ServerEntityIndex({
      count: 2,
      expressId: Uint32Array.from([7, 9]),
      typeName: ['IFCWALL', 'IFCSLAB'],
      globalId: ['G7', null],
      name: [null, 'Slab'],
      description: undefined,
      objectType: undefined,
      tag: undefined,
      predefinedType: undefined,
      hasGeometry: Uint8Array.from([1, 0]),
    });

    assert.deepEqual(index.get(7), {
      entity_id: 7,
      type_name: 'IFCWALL',
      global_id: 'G7',
      name: undefined,
      description: undefined,
      object_type: undefined,
      tag: undefined,
      predefined_type: undefined,
      has_geometry: true,
    });
    assert.deepEqual(index.get(9), {
      entity_id: 9,
      type_name: 'IFCSLAB',
      global_id: undefined,
      name: 'Slab',
      description: undefined,
      object_type: undefined,
      tag: undefined,
      predefined_type: undefined,
      has_geometry: false,
    });
  });
});
