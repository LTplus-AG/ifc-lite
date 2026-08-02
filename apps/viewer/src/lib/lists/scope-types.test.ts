/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for #1662: the New List scope selector omitted element classes
 * present in the model (IfcDuctSegment, IfcPipeSegment) because it drove its
 * chips from a hardcoded curated list. `collectScopeTypes` now derives the
 * offered classes from the model, so every present element class appears.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EntityTableBuilder, StringTable, IfcTypeEnum, type EntityTable } from '@ifc-lite/data';
import { collectScopeTypes, isScopeTargetType, type ScopeTypeStore } from './scope-types.js';

/** [expressId, STEP type name, hasGeometry, isType] */
type Row = [number, string, boolean?, boolean?];

/** Build a minimal store (entity table only, like an IFCX ingest) from a row list. */
function makeStore(rows: Row[]): ScopeTypeStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(rows.length, strings);
  for (const [id, type, hasGeometry = false, isType = false] of rows) {
    builder.add(id, type, `guid-${id}`, `${type}-${id}`, '', '', hasGeometry, isType);
  }
  const entities: EntityTable = builder.build();
  return { entities };
}

describe('collectScopeTypes (#1662)', () => {
  it('offers MEP classes present in the model (IfcDuctSegment / IfcPipeSegment)', () => {
    const store = makeStore([
      [1, 'IFCWALL', true],
      [2, 'IFCSLAB', true],
      [3, 'IFCDUCTSEGMENT', true],
      [4, 'IFCPIPESEGMENT', true],
    ]);

    const offered = collectScopeTypes([store]);
    const types = new Set(offered.map((o) => o.type));

    // The bug: these two were never offered even though present.
    assert.ok(types.has(IfcTypeEnum.IfcDuctSegment), 'IfcDuctSegment must be offered');
    assert.ok(types.has(IfcTypeEnum.IfcPipeSegment), 'IfcPipeSegment must be offered');
    assert.ok(types.has(IfcTypeEnum.IfcWall));
    assert.ok(types.has(IfcTypeEnum.IfcSlab));

    // Unknown-to-the-curator classes fall back to their IFC class name.
    const duct = offered.find((o) => o.type === IfcTypeEnum.IfcDuctSegment);
    assert.strictEqual(duct?.label, 'IfcDuctSegment');
    assert.strictEqual(duct?.count, 1);
    // Curated classes keep their friendly plural label.
    assert.strictEqual(offered.find((o) => o.type === IfcTypeEnum.IfcWall)?.label, 'Walls');
  });

  it('excludes non-element records: type objects, relationships, and unmapped classes', () => {
    const store = makeStore([
      [1, 'IFCWALL', true],
      [2, 'IFCWALLTYPE', false, true],   // type object → excluded
      [3, 'IFCRELAGGREGATES'],           // relationship → excluded
      [4, 'IFCSANITARYTERMINAL', true],  // no distinct enum (Unknown) → excluded
      [5, 'IFCSITE'],                    // spatial structure → offered
    ]);

    const types = new Set(collectScopeTypes([store]).map((o) => o.type));
    assert.ok(types.has(IfcTypeEnum.IfcWall));
    assert.ok(types.has(IfcTypeEnum.IfcSite));
    assert.ok(!types.has(IfcTypeEnum.IfcWallType), 'type objects are not list-able');
    assert.ok(!types.has(IfcTypeEnum.IfcRelAggregates), 'relationships are not list-able');
    assert.ok(!types.has(IfcTypeEnum.Unknown), 'unmapped classes are never offered');
    // Exactly the two list-able classes, nothing leaked in.
    assert.strictEqual(types.size, 2);
  });

  it('counts one entry per enum even when several STEP names share it', () => {
    // IfcDoor and IfcDoorStandardCase both map to the IfcDoor enum.
    const store = makeStore([
      [1, 'IFCDOOR', true],
      [2, 'IFCDOORSTANDARDCASE', true],
    ]);
    const offered = collectScopeTypes([store]);
    const doors = offered.filter((o) => o.type === IfcTypeEnum.IfcDoor);
    assert.strictEqual(doors.length, 1, 'a shared enum yields one chip');
    assert.strictEqual(doors[0].count, 2, 'both STEP-name instances counted, once each');
  });

  it('sums instance counts across federated models', () => {
    const a = makeStore([[1, 'IFCWALL', true], [2, 'IFCWALL', true]]);
    const b = makeStore([[10, 'IFCWALL', true]]);
    const offered = collectScopeTypes([a, b]);
    const wall = offered.find((o) => o.type === IfcTypeEnum.IfcWall);
    assert.strictEqual(wall?.count, 3);
  });

  it('offers chips for IFCX-shaped stores whose entityIndex.byType is permanently empty (#1667 regression)', () => {
    // buildIfcxDataStore creates `entityIndex: { byId: new Map(), byType: new Map() }`
    // and never fills byType; the chips must come from the entity table itself.
    const { entities } = makeStore([[1, 'IFCWALL', true], [2, 'IFCSPACE', true]]);
    const ifcxShaped = { entities, entityIndex: { byId: new Map(), byType: new Map() } };
    const types = new Set(collectScopeTypes([ifcxShaped]).map((o) => o.type));
    assert.ok(types.has(IfcTypeEnum.IfcWall), 'IFCX store must still offer Walls');
    assert.ok(types.has(IfcTypeEnum.IfcSpace), 'IFCX store must still offer Spaces');
  });

  it('predicate rejects the non-element categories directly', () => {
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.IfcDuctSegment, 'IfcDuctSegment'), true);
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.IfcWall, 'IfcWall'), true);
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.Unknown, 'IfcSanitaryTerminal'), false);
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.IfcWallType, 'IfcWallType'), false);
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.IfcRelAggregates, 'IfcRelAggregates'), false);
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.IfcPropertySet, 'IfcPropertySet'), false);
    assert.strictEqual(isScopeTargetType(IfcTypeEnum.IfcElementQuantity, 'IfcElementQuantity'), false);
  });
});
