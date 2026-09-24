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
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
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

async function parsedStore() {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Tower',$,$,$,$,$,$);
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall B',$,$,#24,#28,$,$);
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
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

  it('uses each model’s live entity set for chips and counts (#5249)', async () => {
    const a = await parsedStore();
    const b = await parsedStore();
    const view = new MutablePropertyView(a.properties, 'a');
    view.setExpressIdWatermark(100);
    view.deleteEntity(42);
    view.setEntityType(44, 'IfcWall');
    view.createEntity('IfcWall', ['0NewWall000000000000041', '$', 'Added wall', '$', '$', '#24', '#28', '$', '$']);
    view.createEntity('IfcDuctSegment', ['0NewDuct000000000000041', '$', 'Added duct', '$', '$', '#24', '#28', '$', '$']);
    const removed = view.createEntity('IfcPipeSegment', ['0NewPipe000000000000041', '$', 'Removed pipe', '$', '$', '#24', '#28', '$', '$']);
    view.deleteEntity(removed.expressId);

    const offered = collectScopeTypes([{ store: a, view }, { store: b }]);
    const count = (type: IfcTypeEnum) => offered.find((option) => option.type === type)?.count;
    assert.strictEqual(count(IfcTypeEnum.IfcWall), 5, 'A: deleted wall, retyped door, new wall; B: two untouched walls');
    assert.strictEqual(count(IfcTypeEnum.IfcDoor), 1, 'the untouched second model keeps its door');
    assert.strictEqual(count(IfcTypeEnum.IfcDuctSegment), 1, 'an overlay-only class gets a chip');
    assert.strictEqual(count(IfcTypeEnum.IfcPipeSegment), undefined, 'created then deleted is absent');
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
