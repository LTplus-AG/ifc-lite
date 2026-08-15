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

/**
 * A fake store with a two-level spatial hierarchy (Project → Storey →
 * element) plus a storey elevation, so `buildChildrenByPath` and the
 * `IfcBuildingStorey` elevation attribute (both otherwise untested — the
 * base `makeFakeStore` above always has `spatialHierarchy: null`) are
 * exercised.
 */
function makeFakeStoreWithHierarchy(): IfcDataStore {
  const rows = new Map<number, { guid: string; name: string; desc: string; objType: string; type: string }>([
    [100, { guid: 'GUID-PROJ', name: 'Project', desc: '', objType: '', type: 'IfcProject' }],
    [101, { guid: 'GUID-STOREY', name: 'Level 1', desc: '', objType: '', type: 'IfcBuildingStorey' }],
    [1, { guid: 'GUID-WALL-1', name: 'Wall-A', desc: '', objType: '', type: 'IfcWall' }],
  ]);
  return {
    source: new Uint8Array(0),
    entityIndex: {
      byId: new Map([
        [100, { type: 'IFCPROJECT', byteOffset: 0, byteLength: 0 }],
        [101, { type: 'IFCBUILDINGSTOREY', byteOffset: 0, byteLength: 0 }],
        [1, { type: 'IFCWALL', byteOffset: 0, byteLength: 0 }],
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
    spatialHierarchy: {
      project: {
        expressId: 100,
        children: [{ expressId: 101, children: [], elements: [1] }],
        elements: [],
      },
      storeyElevations: new Map([[101, 3.5]]),
    },
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

  it('builds bsi::ifc::class as the exact IFCX class URI, keyed by proper-cased class', () => {
    const source = buildStepSeedSource(makeFakeStore());
    const wall = Array.from(source.entities).find((e) => e.guid === 'GUID-WALL-1')!;
    assert.ok(wall.attributes, 'seeded entity must carry attributes');
    assert.deepEqual(wall.attributes['bsi::ifc::class'], {
      code: 'IfcWall',
      uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/IfcWall',
    });
  });

  it('falls back to the raw (uppercase) STEP type when the table has no proper-cased name', () => {
    const rows = new Map([[1, { guid: 'GUID-X', name: '', desc: '', objType: '', type: 'Unknown' }]]);
    const store = {
      source: new Uint8Array(0),
      entityIndex: { byId: new Map([[1, { type: 'IFCSOMERESOURCE', byteOffset: 0, byteLength: 0 }]]), byType: new Map() },
      entities: {
        getGlobalId: (id: number) => rows.get(id)?.guid ?? '',
        getName: () => '',
        getDescription: () => '',
        getObjectType: () => '',
        getTypeName: (id: number) => rows.get(id)?.type ?? 'Unknown',
      },
      properties: { getForEntity: () => [] },
      relationships: { getRelated: () => [] },
      spatialHierarchy: null,
      schemaVersion: 'IFC4',
    } as unknown as IfcDataStore;

    const entity = Array.from(buildStepSeedSource(store).entities)[0];
    assert.strictEqual(entity.ifcClass, 'IFCSOMERESOURCE', 'must use the raw STEP type, not "Unknown"');
  });

  it('carries schemaVersion and fileName through to the seed header', () => {
    const source = buildStepSeedSource(makeFakeStore(), 'my-model.ifc');
    assert.strictEqual(source.header?.schema, 'IFC4');
    assert.strictEqual(source.header?.fileName, 'my-model.ifc');
  });

  it('header.fileName is undefined when no fileName is passed', () => {
    const source = buildStepSeedSource(makeFakeStore());
    assert.strictEqual(source.header?.fileName, undefined);
  });
});

/**
 * A fake store with a REAL (tiny) STEP source buffer wired through
 * `onDemandPropertyMap`, so the property-set → `bsi::ifc::prop::<Pset>::<Prop>`
 * flattening loop is exercised. The other fixtures in this file always pass
 * an empty `source`, so `extractPropertiesOnDemand` short-circuits to `[]`
 * and never enters this loop — leaving it a coverage gap.
 */
function makeFakeStoreWithProperties(): IfcDataStore {
  const lines = [
    `#1=IFCWALL('GUID-WALL-1',$,$,$,$,$,$,$,$);`,
    `#10=IFCPROPERTYSET('pset-guid',$,'Pset_WallCommon',$,(#11,#12));`,
    `#11=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);`,
    // A property with no nominal value ($) — must NOT materialize an
    // attribute at all (a `null`/`undefined` written as a real attribute
    // value would corrupt the flat IFCX attribute shape).
    `#12=IFCPROPERTYSINGLEVALUE('EmptyProp',$,$,$);`,
  ];
  const enc = new TextEncoder();
  const byId = new Map<number, { type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  let offset = 0;
  for (const line of lines) {
    const bytes = enc.encode(line);
    const m = line.match(/^#(\d+)=(\w+)\(/)!;
    byId.set(Number(m[1]), { type: m[2], byteOffset: offset, byteLength: bytes.length, lineNumber: 1 });
    offset += bytes.length + 1;
  }
  const rows = new Map([[1, { guid: 'GUID-WALL-1', name: 'Wall-A', desc: '', objType: '', type: 'IfcWall' }]]);
  return {
    source: enc.encode(lines.join('\n') + '\n'),
    entityIndex: { byId, byType: new Map() },
    onDemandPropertyMap: new Map([[1, [10]]]),
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

describe('collab step-seed property sets', () => {
  it('flattens a Pset property into bsi::ifc::prop::<Pset>::<Prop>, namespaced and value-preserved', () => {
    const source = buildStepSeedSource(makeFakeStoreWithProperties());
    const wall = Array.from(source.entities).find((e) => e.guid === 'GUID-WALL-1')!;
    assert.ok(wall.attributes, 'seeded entity must carry attributes');
    assert.strictEqual(wall.attributes['bsi::ifc::prop::Pset_WallCommon::IsExternal'], true);
    // A property with a null/absent nominal value must be dropped, not
    // materialized as a `null`/`undefined` attribute.
    assert.ok(!('bsi::ifc::prop::Pset_WallCommon::EmptyProp' in wall.attributes));
  });
});

describe('collab step-seed spatial hierarchy (buildChildrenByPath)', () => {
  it('builds a per-parent children map covering BOTH spatial decomposition and element containment', () => {
    const source = buildStepSeedSource(makeFakeStoreWithHierarchy());
    const entities = Array.from(source.entities);

    const project = entities.find((e) => e.guid === 'GUID-PROJ')!;
    const storey = entities.find((e) => e.guid === 'GUID-STOREY')!;
    const wall = entities.find((e) => e.guid === 'GUID-WALL-1')!;

    // Project → Storey (spatial decomposition).
    assert.deepEqual(project.children, { '/GUID-STOREY': '/GUID-STOREY' });
    // Storey → Wall (element containment) — a DIFFERENT loop in
    // buildChildrenByPath than the decomposition one above; a fixture with
    // only one of the two shapes present can't catch either loop being
    // deleted independently, so this test asserts both parents at once.
    assert.deepEqual(storey.children, { '/GUID-WALL-1': '/GUID-WALL-1' });
    // A leaf entity has no children entry at all (buildChildrenByPath only
    // sets a key when the children record is non-empty).
    assert.strictEqual(wall.children, undefined);
  });

  it('derives the IfcBuildingStorey elevation attribute from storeyElevations, keyed by expressId', () => {
    const source = buildStepSeedSource(makeFakeStoreWithHierarchy());
    const storey = Array.from(source.entities).find((e) => e.guid === 'GUID-STOREY')!;
    assert.ok(storey.attributes, 'seeded storey must carry attributes');
    assert.strictEqual(storey.attributes['bsi::ifc::prop::Elevation'], 3.5);

    // A non-storey entity must never get an Elevation attribute, even though
    // it's also present in storeyElevations-adjacent code paths.
    const project = Array.from(source.entities).find((e) => e.guid === 'GUID-PROJ')!;
    assert.ok(project.attributes, 'seeded project must carry attributes');
    assert.ok(!('bsi::ifc::prop::Elevation' in project.attributes));
  });
});
