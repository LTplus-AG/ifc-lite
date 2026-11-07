/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9013 requirement 2 and 4: attached walls follow the storey above, fixed
 * walls keep their height, stairs refit to land exactly, and invalid outcomes
 * are refused before anything is written. Built the way the Model workspace
 * builds a house from "Start blank".
 */

import * as create from '../../index.js';
import { describe, expect, it } from 'vitest';
import { recordCompoundMutation, undoRecordedMutationOperations, StoreEditor } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '../../ifc-creator.js';
import { addOrdinaryElementInStore } from '../ordinary-element.js';
import { addHostedElementInStore } from '../hosted-element.js';
import { addStairToStore } from '../stair.js';
import { readStairDimensions } from '../stair-edit.js';
import { readWallMetres } from '../wall-size-edit.js';
import { resolveSpatialAnchor } from '../resolve-anchor.js';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../__test__/stair-mesh.oracle.js';
import { parse, session, type Session } from '../__test__/storey-fixtures.oracle.js';
import { readPlacementLeaf, writeShiftedPlacement } from './storey-placement.js';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { refId } from '../host-geometry-frame.js';

/** #9013: the storey API through the package boundary. A revert of production fails this assertion, not a module load. */
function api<K extends keyof typeof create>(name: K): (typeof create)[K] {
  expect(typeof create[name], `${String(name)} is exported by @ifc-lite/create`).toBe('function');
  return create[name];
}


interface House extends Session { level1: number; level2: number; attached: number; fixed: number; door: number; window: number; stair: number; flight: number }

/** Start blank, draw on Level 1, then add Level 2 at +3.00 (acceptance steps 1-3). */
async function house(): Promise<House> {
  const creator = new IfcCreator({ Name: 'Blank' });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const level1 = api('readStoreyInventory')(s.store, s.view).storeys[0].expressId;
  const anchor = (draft: StoreEditor) => resolveSpatialAnchor(s.store, level1, draft.getMutationView());
  const wall = (Start: [number, number, number], End: [number, number, number]) =>
    addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start, End, Thickness: 0.2, Height: 3 } });
  const attached = wall([0, 0, 0], [6, 0, 0]);
  const fixed = wall([0, 4, 0], [6, 4, 0]);
  // Drawn as attached before any storey stood above it.
  api('writeTopAttachment')(s.view, attached, create.NEXT_STOREY_ABOVE);
  const door = addHostedElementInStore(s.store, s.editor, attached, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } }).expressId;
  const window = addHostedElementInStore(s.store, s.editor, attached, { kind: 'window', params: { Offset: 3, Width: 1.2, Height: 1.2, Sill: 0.9 } }).expressId;
  const stairBuilt = s.editor.runAtomic((draft) => addStairToStore(draft, anchor(draft), {
    Position: [2, 1, 0], NumberOfRisers: 17, RiserHeight: 3 / 17, TreadLength: 0.27, Width: 1,
  }));
  const level2 = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 }).storeyId;
  return { ...s, level1, level2, attached, fixed, door, window, stair: stairBuilt.stairId, flight: stairBuilt.flightId };
}

const height = (h: House, wall: number) => readWallMetres({ dataStore: h.store, view: h.view, editor: h.editor }, wall)!.height;

describe('adding the storey above binds walls drawn attached', () => {
  it('records the new storey GlobalId; the fixed wall stays fixed', async () => {
    const h = await house();
    const inventory = api('readStoreyInventory')(h.store, h.view);
    expect(api('readTopAttachment')(inventory, h.attached)).toEqual({ targetStoreyId: h.level2, source: 'ifclite' });
    expect(api('readTopAttachment')(inventory, h.fixed)).toBeNull();
    expect(height(h, h.attached)).toBeCloseTo(3, 9);
  });

  it('resizes a bound wall to reach a storey added higher than its height', async () => {
    const creator = new IfcCreator({ Name: 'Blank' });
    creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    const s = session(await parse(creator.toIfc().content));
    const level1 = api('readStoreyInventory')(s.store, s.view).storeys[0].expressId;
    const wall = addOrdinaryElementInStore(s.editor, (draft) => resolveSpatialAnchor(s.store, level1, draft.getMutationView()),
      { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    api('writeTopAttachment')(s.view, wall, create.NEXT_STOREY_ABOVE);
    const added = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3.2 });
    expect(added.boundWalls.map(({ wallId, from, to }) => [wallId, from, Math.round(to * 1e6) / 1e6])).toEqual([[wall, 3, 3.2]]);
    expect(readWallMetres({ dataStore: s.store, view: s.view, editor: s.editor }, wall)!.height).toBeCloseTo(3.2, 9);
  });
});

describe('wall attachments are followed exactly as recorded (#9036 review)', () => {
  /** Blank Level 1 with one 3 m wall; returns the session and ids. */
  async function oneWall() {
    const creator = new IfcCreator({ Name: 'Blank' });
    creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    const s = session(await parse(creator.toIfc().content));
    const level1 = api('readStoreyInventory')(s.store, s.view).storeys[0].expressId;
    const wall = addOrdinaryElementInStore(s.editor, (draft) => resolveSpatialAnchor(s.store, level1, draft.getMutationView()),
      { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    return { s, level1, wall };
  }

  it('a wall attached to a deleted storey is reported when its own storey moves, even with nothing above', async () => {
    const { s, level1, wall } = await oneWall();
    const level2 = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 }).storeyId;
    const guid = api('readStoreyInventory')(s.store, s.view).storeys.find((x) => x.expressId === level2)!.GlobalId;
    api('writeTopAttachment')(s.view, wall, guid);
    api('applyStoreyDelete')(s.store, s.editor, level2, { kind: 'empty' });
    const plan = api('planStoreyLevelEdit')(api('readStoreyInventory')(s.store, s.view), { kind: 'elevation', storeyId: level1, Elevation: 0.5 });
    expect(plan.notices.map((n) => [n.code, n.elementIds])).toEqual([['wallAttachmentUnresolved', [wall]]]);
  });

  it('a wall bound to a new storey keeps its quantities true', async () => {
    const { s, wall } = await oneWall();
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'GrossSideArea', 12, QuantityType.Area);
    api('writeTopAttachment')(s.view, wall, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3.2 });
    const qto = s.view.getQuantitiesForEntity(wall).find((set) => set.name === 'Qto_WallBaseQuantities')!;
    expect(qto.quantities.find((q) => q.name === 'Height')?.value).toBeCloseTo(3.2, 9);
    expect(qto.quantities.find((q) => q.name === 'GrossSideArea')?.value).toBeCloseTo(12.8, 9);
  });

  it('making a Revit-attached wall fixed sticks; a Revit level no storey matches is reported, not guessed', async () => {
    const { s, level1, wall } = await oneWall();
    const level2 = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 }).storeyId;
    s.view.setProperty(wall, 'Constraints', 'Top Constraint', 'Up to level: Level 2', PropertyValueType.Label);
    expect(api('readTopAttachment')(api('readStoreyInventory')(s.store, s.view), wall)).toEqual({ targetStoreyId: level2, source: 'revit' });
    api('clearTopAttachment')(s.view, wall);
    expect(api('readTopAttachment')(api('readStoreyInventory')(s.store, s.view), wall)).toBeNull();

    // A Revit record naming a level that was renamed: listed as a notice, height left as it is.
    s.view.setProperty(wall, 'IfcLite_StoreyAttachment', 'TopConstraint', '', PropertyValueType.Label);
    api('renameStoreyInStore')(s.store, s.editor, level2, 'Roof');
    const inventory = api('readStoreyInventory')(s.store, s.view);
    expect(api('topAttachmentProblem')(inventory, wall)).toBe('Revit records its top up to level "Level 2", which no storey is called');
    const plan = api('planStoreyLevelEdit')(inventory, { kind: 'floorHeight', storeyId: level1, Height: 3.5 });
    expect(plan.walls).toEqual([]);
    expect(plan.notices.map((n) => [n.code, n.elementIds])).toEqual([['wallAttachmentUnresolved', [wall]]]);
  });
});

describe('quantities and stairs as the file records them (#9036 review)', () => {
  async function blank() {
    const creator = new IfcCreator({ Name: 'Blank' });
    creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    const s = session(await parse(creator.toIfc().content));
    const level1 = api('readStoreyInventory')(s.store, s.view).storeys[0].expressId;
    const anchor = (draft: StoreEditor) => resolveSpatialAnchor(s.store, level1, draft.getMutationView());
    return { s, level1, anchor };
  }

  it('a net side area without a gross one changes by the gross change the set implies', async () => {
    const { s, level1, anchor } = await blank();
    const wall = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    // A 4 m x 3 m wall with a 2 m2 opening, recorded without its gross area.
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Length', 4, QuantityType.Length);
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'NetSideArea', 10, QuantityType.Area);
    api('writeTopAttachment')(s.view, wall, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'floorHeight', storeyId: level1, Height: 4 });
    const qto = s.view.getQuantitiesForEntity(wall).find((set) => set.name === 'Qto_WallBaseQuantities')!;
    expect(qto.quantities.find((q) => q.name === 'NetSideArea')?.value).toBeCloseTo(14, 9);
  });

  it('quantities that exist only in the source file are kept true, with no quantity extractor on the view', async () => {
    const { s, anchor } = await blank();
    const drawn = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    s.view.setQuantity(drawn, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
    s.view.setQuantity(drawn, 'Qto_WallBaseQuantities', 'GrossSideArea', 12, QuantityType.Area);
    api('writeTopAttachment')(s.view, drawn, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    // Reload: the set now lives in the source file only; this session's view has no quantity extractor.
    const r = session(await parse(s.text()));
    expect(r.view.hasQuantityBase()).toBe(false);
    const inventory = api('readStoreyInventory')(r.store, r.view);
    const wall = inventory.store.entityIndex.byType.get('IFCWALL')![0];
    api('applyStoreyLevelEdit')(r.store, r.editor, { kind: 'floorHeight', storeyId: inventory.storeys[0].expressId, Height: 4 });
    const qto = r.view.getQuantitiesForEntity(wall, (id) => extractQuantitiesOnDemand(r.store, id)).find((set) => set.name === 'Qto_WallBaseQuantities')!;
    expect(qto.quantities.find((q) => q.name === 'Height')?.value).toBeCloseTo(4, 9);
    expect(qto.quantities.find((q) => q.name === 'GrossSideArea')?.value).toBeCloseTo(16, 9);
  });

  it('a set with only a net side area takes the gross change from the wall itself', async () => {
    const { s, level1, anchor } = await blank();
    const wall = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    // A 4 m x 3 m wall with a 2 m2 opening; the set records nothing but the net area.
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'NetSideArea', 10, QuantityType.Area);
    api('writeTopAttachment')(s.view, wall, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'floorHeight', storeyId: level1, Height: 4 });
    const qto = s.view.getQuantitiesForEntity(wall).find((set) => set.name === 'Qto_WallBaseQuantities')!;
    expect(qto.quantities.find((q) => q.name === 'NetSideArea')?.value).toBeCloseTo(14, 9);
  });

  it('without a gross value the set\'s own Length and Height come before the wall\'s geometry', async () => {
    const { s, level1, anchor } = await blank();
    const wall = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    // The set measures 3.5 m of the 4 m wall (say, between other walls).
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Length', 3.5, QuantityType.Length);
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
    s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'NetSideArea', 8, QuantityType.Area);
    api('writeTopAttachment')(s.view, wall, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'floorHeight', storeyId: level1, Height: 4 });
    const qto = s.view.getQuantitiesForEntity(wall).find((set) => set.name === 'Qto_WallBaseQuantities')!;
    expect(qto.quantities.find((q) => q.name === 'NetSideArea')?.value).toBeCloseTo(11.5, 9);
  });

  it('a net side area in mm² beside a gross one in m² changes by the gross change, converted', async () => {
    const { s, anchor } = await blank();
    const drawn = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    api('writeTopAttachment')(s.view, drawn, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    // The exported file gains a quantity set whose net area carries its own unit (mm²).
    let text = s.text();
    const wallRef = /^#(\d+)=IFCWALL\(/m.exec(text)![1];
    text = text.replace('ENDSEC;\nEND-ISO', `#900001=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);
#900002=IFCQUANTITYLENGTH('Height',$,$,3.,$);
#900003=IFCQUANTITYAREA('GrossSideArea',$,$,12.,$);
#900004=IFCQUANTITYAREA('NetSideArea',$,#900001,10000000.,$);
#900005=IFCELEMENTQUANTITY('3QtoWaLLAAAAAAAAAAAAAA',$,'Qto_WallBaseQuantities',$,$,(#900002,#900003,#900004));
#900006=IFCRELDEFINESBYPROPERTIES('3QtoReLLAAAAAAAAAAAAAA',$,$,$,(#${wallRef}),#900005);
ENDSEC;
END-ISO`);
    const r = session(await parse(text));
    const inventory = api('readStoreyInventory')(r.store, r.view);
    api('applyStoreyLevelEdit')(r.store, r.editor, { kind: 'floorHeight', storeyId: inventory.storeys[0].expressId, Height: 4 });
    const qto = r.view.getQuantitiesForEntity(Number(wallRef), (id) => extractQuantitiesOnDemand(r.store, id)).find((set) => set.name === 'Qto_WallBaseQuantities')!;
    expect(qto.quantities.find((q) => q.name === 'GrossSideArea')?.value).toBeCloseTo(16, 9);
    // 10 m² net + 4 m² of gross change, in mm².
    expect(qto.quantities.find((q) => q.name === 'NetSideArea')?.value).toBeCloseTo(14_000_000, 3);
  });

  it('a wall drawn attached whose body cannot be read is still bound by the storey above, and reported', async () => {
    const { s, level1 } = await blank();
    const storeyPlacement = refId(new AnchorEntityReader(s.store, s.view).entity(level1)?.attributes[5])!;
    const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const placement = s.editor.addEntity('IfcLocalPlacement', [`#${storeyPlacement}`, `#${axis}`]).expressId;
    const wall = s.editor.addEntity('IfcWall', ['1BoDyLeSSAAAAAAAAAAAAA', null, 'No body', null, null, `#${placement}`, null, null, null]).expressId;
    s.editor.addEntity('IfcRelContainedInSpatialStructure', ['1BoDyReLLAAAAAAAAAAAAA', null, null, null, [`#${wall}`], `#${level1}`]);
    api('writeTopAttachment')(s.view, wall, create.NEXT_STOREY_ABOVE);
    const added = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    expect(added.unresizedWalls).toEqual([wall]);
    expect(added.boundWalls).toEqual([]);
    expect(api('readTopAttachment')(api('readStoreyInventory')(s.store, s.view), wall)).toEqual({ targetStoreyId: added.storeyId, source: 'ifclite' });
  });

  it('an imported stair whose recorded flight sits above it is reported when its landing moves', async () => {
    const { s, level1 } = await blank();
    const reader = new AnchorEntityReader(s.store, s.view);
    const storeyPlacement = refId(reader.entity(level1)?.attributes[5])!;
    const place = (parent: number, z: number) => {
      const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, z]]).expressId;
      const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
      return s.editor.addEntity('IfcLocalPlacement', [`#${parent}`, `#${axis}`]).expressId;
    };
    const stairPlacement = place(storeyPlacement, 0);
    const stair = s.editor.addEntity('IfcStair', ['2ImPoRtStAIRAAAAAAAAAA', null, 'Imported stair', null, null, `#${stairPlacement}`, null, null, '.STRAIGHT_RUN_STAIR.']).expressId;
    // A flight with a recorded 3 m rise (15 x 0.2 m), raised 0.2 m inside the stair, with no body this editor can rebuild.
    const flight = s.editor.addEntity('IfcStairFlight', ['2ImPoRtFLiGHTAAAAAAAAA', null, 'Flight', null, null, `#${place(stairPlacement, 0.2)}`, null, null, 15, 15, 0.2, 0.27, '.STRAIGHT.']).expressId;
    s.editor.addEntity('IfcRelAggregates', ['2ImPoRtAgGRAAAAAAAAAAA', null, null, null, `#${stair}`, [`#${flight}`]]);
    s.editor.addEntity('IfcRelContainedInSpatialStructure', ['2ImPoRtCoNTAAAAAAAAAAA', null, null, null, [`#${stair}`], `#${level1}`]);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3.2 });
    const plan = api('planStoreyLevelEdit')(api('readStoreyInventory')(s.store, s.view), { kind: 'floorHeight', storeyId: level1, Height: 3.5 });
    expect(plan.notices.find((n) => n.code === 'stairNotRefit')?.elementIds).toEqual([stair]);
  });

  it('a reviewed plan is stale once a notice appears since (an unrefittable stair added)', async () => {
    const { s, level1 } = await blank();
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    const edit = { kind: 'floorHeight', storeyId: level1, Height: 3.5 } as const;
    const reviewed = api('planStoreyLevelEdit')(api('readStoreyInventory')(s.store, s.view), edit);
    expect(reviewed.notices).toEqual([]);
    // An imported stair that lands on Level 2 but has no flight this editor can rebuild.
    const storeyPlacement = refId(new AnchorEntityReader(s.store, s.view).entity(level1)?.attributes[5])!;
    const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const placement = s.editor.addEntity('IfcLocalPlacement', [`#${storeyPlacement}`, `#${axis}`]).expressId;
    const stair = s.editor.addEntity('IfcStair', ['2LaTeStAIRAAAAAAAAAAAA', null, 'Late stair', null, null, `#${placement}`, null, null, '.STRAIGHT_RUN_STAIR.']).expressId;
    const flight = s.editor.addEntity('IfcStairFlight', ['2LaTeFLiGHTAAAAAAAAAAA', null, 'Flight', null, null, `#${placement}`, null, null, 15, 15, 0.2, 0.27, '.STRAIGHT.']).expressId;
    s.editor.addEntity('IfcRelAggregates', ['2LaTeAgGRAAAAAAAAAAAAA', null, null, null, `#${stair}`, [`#${flight}`]]);
    s.editor.addEntity('IfcRelContainedInSpatialStructure', ['2LaTeCoNTAAAAAAAAAAAAA', null, null, null, [`#${stair}`], `#${level1}`]);
    expect(api('planStoreyLevelEdit')(api('readStoreyInventory')(s.store, s.view), edit).notices.map((n) => n.code)).toEqual(['stairNotRefit']);
    expect(() => api('applyStoreyLevelEdit')(s.store, s.editor, edit, reviewed)).toThrow('planned against a model that has changed');
  });

  it('a resized wall with two Qto_WallBaseQuantities sets is named in a notice', async () => {
    const { s, anchor } = await blank();
    const drawn = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } });
    api('writeTopAttachment')(s.view, drawn, create.NEXT_STOREY_ABOVE);
    api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    let text = s.text();
    const wallRef = /^#(\d+)=IFCWALL\(/m.exec(text)![1];
    text = text.replace('ENDSEC;\nEND-ISO', `#900001=IFCQUANTITYLENGTH('Height',$,$,3.,$);
#900002=IFCELEMENTQUANTITY('3QtoOnEEAAAAAAAAAAAAAA',$,'Qto_WallBaseQuantities',$,$,(#900001));
#900003=IFCRELDEFINESBYPROPERTIES('3QtoOnERAAAAAAAAAAAAAA',$,$,$,(#${wallRef}),#900002);
#900004=IFCQUANTITYLENGTH('Height',$,$,3.,$);
#900005=IFCELEMENTQUANTITY('3QtoTwOEAAAAAAAAAAAAAA',$,'Qto_WallBaseQuantities',$,$,(#900004));
#900006=IFCRELDEFINESBYPROPERTIES('3QtoTwORAAAAAAAAAAAAAA',$,$,$,(#${wallRef}),#900005);
ENDSEC;
END-ISO`);
    const r = session(await parse(text));
    const inventory = api('readStoreyInventory')(r.store, r.view);
    const plan = api('planStoreyLevelEdit')(inventory, { kind: 'floorHeight', storeyId: inventory.storeys[0].expressId, Height: 4 });
    expect(plan.walls.map((w) => w.wallId)).toEqual([Number(wallRef)]);
    expect(plan.notices.find((n) => n.code === 'wallQuantitiesPartial')?.elementIds).toEqual([Number(wallRef)]);
  });

  it('a flight that sits above its stair\'s placement lands, and refits, at its own top', async () => {
    const { s, level1, anchor } = await blank();
    const built = s.editor.runAtomic((draft) => addStairToStore(draft, anchor(draft), {
      Position: [2, 1, 0], NumberOfRisers: 15, RiserHeight: 0.2, TreadLength: 0.27, Width: 1,
    }));
    // Raise the flight 0.2 m inside its stair: its top is now at 3.2 m.
    const reader = new AnchorEntityReader(s.store, s.view);
    const flightPlacement = refId(reader.entity(built.flightId)?.attributes[5])!;
    writeShiftedPlacement(s.editor, readPlacementLeaf(reader, flightPlacement)!, [0, 0, 0.2]);
    const level2 = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3.2 }).storeyId;
    const plan = api('planStoreyLevelEdit')(api('readStoreyInventory')(s.store, s.view), { kind: 'floorHeight', storeyId: level1, Height: 3.5 });
    expect(plan.stairs.map((stair) => [stair.stairId, stair.landingStoreyId])).toEqual([[built.stairId, level2]]);
    // From 3.0 m to 3.3 m of rise: the flight still lands exactly on Level 2.
    expect(plan.stairs[0].to.NumberOfRisers * plan.stairs[0].to.RiserHeight).toBeCloseTo(3.3, 9);
  });
});

describe('floor-to-floor height drives attached walls and stairs (acceptance step 4)', () => {
  it('plans the impact: moves Level 2, resizes the attached wall, refits the stair', async () => {
    const h = await house();
    const p = api('planStoreyLevelEdit')(api('readStoreyInventory')(h.store, h.view), { kind: 'floorHeight', storeyId: h.level1, Height: 3.5 });
    expect(p.refusals).toEqual([]);
    expect(p.walls.map(({ wallId, from, to }) => [wallId, from, to])).toEqual([[h.attached, 3, 3.5]]);
    expect(p.stairs.map(({ stairId, from, to }) => [stairId, from.NumberOfRisers, to.NumberOfRisers, Math.round(to.RiserHeight * 1e6)]))
      .toEqual([[h.stair, 17, 20, 175000]]);
  });

  it('applies it: the attached wall grows, the fixed one keeps 3.00, the stair lands exactly, openings stay', async () => {
    const h = await house();
    const before = h.snapshot();
    recordCompoundMutation(h.view, (draft) => api('applyStoreyLevelEdit')(h.store, new StoreEditor(h.store, draft), { kind: 'floorHeight', storeyId: h.level1, Height: 3.5 }));
    expect(height(h, h.attached)).toBeCloseTo(3.5, 9);
    expect(height(h, h.fixed)).toBeCloseTo(3, 9);
    const stair = readStairDimensions(h.store, h.stair, h.view)!;
    expect(stair.NumberOfRisers).toBe(20);
    expect(stair.NumberOfRisers * stair.RiserHeight).toBeCloseTo(3.5, 9);
    expect(h.worldZ(h.level2)).toBeCloseTo(3.5, 9);
    // The door and window still hang from the (unmoved) wall at the same heights.
    expect(h.worldZ(h.door)).toBeCloseTo(0, 9);
    expect(h.worldZ(h.window)).toBeCloseTo(0.9, 9);
    // One undo step restores everything.
    undoRecordedMutationOperations(h.view, 1, () => { throw new Error('one compound edit expected'); });
    expect(h.snapshot()).toEqual(before);
    expect(height(h, h.attached)).toBeCloseTo(3, 9);
  });

  it.skipIf(!stairWasmAvailable)('the exported geometry agrees: wall top and top tread at +3.50, fixed wall at +3.00', async () => {
    const h = await house();
    api('applyStoreyLevelEdit')(h.store, h.editor, { kind: 'floorHeight', storeyId: h.level1, Height: 3.5 });
    for (const schema of ['IFC4', 'IFC4X3'] as const) {
      const meshes = await meshStairs(h.text(schema));
      expect(stairMeshBounds(meshes.get(h.attached)!).max[2]).toBeCloseTo(3.5, 4);
      expect(stairMeshBounds(meshes.get(h.fixed)!).max[2]).toBeCloseTo(3, 4);
      expect(stairMeshBounds(meshes.get(h.flight)!).max[2]).toBeCloseTo(3.5, 4);
      const reloaded = session(await parse(h.text(schema)));
      const inventory = api('readStoreyInventory')(reloaded.store, reloaded.view);
      expect(inventory.storeys.map((x) => x.elevation)).toEqual([0, 3.5]);
      expect(api('readTopAttachment')(inventory, h.attached)?.targetStoreyId).toBe(h.level2);
    }
  });

  it('editing Level 2 elevation directly moves only Level 2 and still drives the walls below (step 5)', async () => {
    const h = await house();
    const p = api('planStoreyLevelEdit')(api('readStoreyInventory')(h.store, h.view), { kind: 'elevation', storeyId: h.level2, Elevation: 2.8 });
    expect(p.storeys.map((x) => x.expressId)).toEqual([h.level2]);
    expect(p.walls.map((w) => [w.wallId, w.to])).toEqual([[h.attached, expect.closeTo(2.8, 9)]]);
    expect(p.stairs[0].to.NumberOfRisers).toBe(16);
  });
});

describe('invalid outcomes are refused with a specific message and nothing written (step 6)', () => {
  it('refuses a spacing no stair flight fits', async () => {
    const h = await house();
    const before = h.snapshot();
    const edit = { kind: 'floorHeight', storeyId: h.level1, Height: 0.25 } as const;
    const [refusal] = api('planStoreyLevelEdit')(api('readStoreyInventory')(h.store, h.view), edit).refusals;
    expect(refusal.code).toBe('dependent');
    expect(refusal.elementIds).toEqual([h.stair]);
    expect(refusal.message).toBe(`The stair #${h.stair} from Level 1 to Level 2 would have to climb 0.25 m: no flight fits; move or delete the stair first`);
    expect(() => api('applyStoreyLevelEdit')(h.store, h.editor, edit)).toThrow(api('StoreyEditRefusedError'));
    expect(h.snapshot()).toEqual(before);
  });

  it('refuses a wall top that would cut through its door (dry run)', async () => {
    const h = await house();
    // Remove the stair from the question: it is the wall that cannot follow.
    const p = api('planStoreyLevelEdit')(api('readStoreyInventory')(h.store, h.view), { kind: 'elevation', storeyId: h.level2, Elevation: 1.8 });
    expect(p.refusals.map((r) => r.code)).toEqual(['dependent']);
    expect(p.refusals[0].message).toMatch(/reaches above the new top of the wall/);
    // Applying that reviewed plan answers with the same refusal, not as a stale plan.
    let refusal: unknown = null;
    try { api('applyStoreyLevelEdit')(h.store, h.editor, { kind: 'elevation', storeyId: h.level2, Elevation: 1.8 }, p); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(api('StoreyEditRefusedError'));
    expect((refusal as InstanceType<typeof create.StoreyEditRefusedError>).refusals.map((r) => r.code)).toEqual(['dependent']);
  });
});
