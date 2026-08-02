/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * buildStepSeedSource must derive root attributes (Name / Description /
 * ObjectType) from the cached columnar entity TABLE, never by re-parsing the
 * source buffer per entity (`extractEntityAttributesOnDemand` is O(parse) per
 * call and this adapter loops over every entity — see AGENTS.md). The fake
 * store below carries NO source bytes, so any code path that falls back to
 * source re-parsing yields empty attributes and fails the assertions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildStepSeedSource } from './step-seed.js';
import type { IfcDataStore } from '@ifc-lite/parser';

function makeFakeStore(): IfcDataStore {
  const rows = new Map<number, { guid: string; name: string; desc: string; objType: string; type: string }>([
    [1, { guid: 'GUID-WALL-1', name: 'Wall-A', desc: 'Load bearing', objType: 'Basic Wall', type: 'IfcWall' }],
    [2, { guid: 'GUID-DOOR-2', name: 'Door-B', desc: '', objType: '', type: 'IfcDoor' }],
    // No GUID → not IfcRoot-derived → must be skipped entirely.
    [3, { guid: '', name: 'Point', desc: '', objType: '', type: 'IfcCartesianPoint' }],
  ]);
  return {
    // Empty source: a per-entity re-parse path can't produce any attribute.
    source: new Uint8Array(0),
    entityIndex: {
      byId: new Map([
        [1, { type: 'IFCWALL', byteOffset: 0, byteLength: 0 }],
        [2, { type: 'IFCDOOR', byteOffset: 0, byteLength: 0 }],
        [3, { type: 'IFCCARTESIANPOINT', byteOffset: 0, byteLength: 0 }],
      ]),
      byType: new Map(),
    },
    entities: {
      getGlobalId: (id: number) => rows.get(id)?.guid ?? '',
      getName: (id: number) => rows.get(id)?.name ?? '',
      getDescription: (id: number) => rows.get(id)?.desc ?? '',
      getObjectType: (id: number) => rows.get(id)?.objType ?? '',
      getTypeName: (id: number) => rows.get(id)?.type ?? 'Unknown',
    },
    properties: { getForEntity: () => [] },
    relationships: { getRelated: () => [] },
    spatialHierarchy: null,
    schemaVersion: 'IFC4',
  } as unknown as IfcDataStore;
}

describe('collab step-seed source adapter', () => {
  it('derives root attributes from the entity table (no source re-parse)', () => {
    const source = buildStepSeedSource(makeFakeStore(), 'model.ifc');
    const entities = Array.from(source.entities);

    assert.strictEqual(entities.length, 2, 'GUID-less entities are skipped');

    const wall = entities.find((e) => e.guid === 'GUID-WALL-1');
    assert.ok(wall?.attributes);
    assert.strictEqual(wall.ifcClass, 'IfcWall');
    assert.strictEqual(wall.attributes['bsi::ifc::prop::Name'], 'Wall-A');
    assert.strictEqual(wall.attributes['bsi::ifc::prop::Description'], 'Load bearing');
    assert.strictEqual(wall.attributes['bsi::ifc::prop::ObjectType'], 'Basic Wall');

    const door = entities.find((e) => e.guid === 'GUID-DOOR-2');
    assert.ok(door?.attributes);
    assert.strictEqual(door.attributes['bsi::ifc::prop::Name'], 'Door-B');
    // Empty table values must not materialize empty attributes.
    assert.ok(!('bsi::ifc::prop::Description' in door.attributes));
    assert.ok(!('bsi::ifc::prop::ObjectType' in door.attributes));
  });

  it('is re-iterable (the seed consumes the source more than once)', () => {
    const source = buildStepSeedSource(makeFakeStore());
    assert.strictEqual(Array.from(source.entities).length, 2);
    assert.strictEqual(Array.from(source.entities).length, 2);
  });
});
