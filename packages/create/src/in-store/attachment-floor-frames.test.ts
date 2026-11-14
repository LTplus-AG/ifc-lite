/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { readWallMetres } from './wall-size-edit.js';
import { copyBatchInStore } from './copy-batch.js';
import { addSlabToStore } from './slab.js';
import { setTopConstraintInStore } from './storey/storey-top-constraint.js';
import { attachedTopWorldOrigin, levelTopFaceAbove, readAttachedTop, writeAttachedTop } from './storey/storey-attached.js';
import { addStoreyInStore, planStoreyAdd } from './storey/storey-add.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { homeStoreyOf, readTopAttachment, writeTopAttachment } from './storey/storey-attachment.js';
import { parse, session, type Session } from './__test__/storey-fixtures.oracle.js';

async function setup(Height = 6) {
  const creator = new IfcCreator({ Name: 'Floor frames' });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const home = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const middle = addStoreyInStore(s.store, s.editor, { Name: 'Middle', Elevation: 3 }).storeyId;
  const upper = addStoreyInStore(s.store, s.editor, { Name: 'Upper', Elevation: 6 }).storeyId;
  const wall = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height } });
  return { s, home, middle, upper, wall };
}
const height = (s: Session, id: number) => readWallMetres({ dataStore: s.store, editor: s.editor, view: s.view }, id)!.height;
const guid = (s: Session, id: number) => readStoreyInventory(s.store, s.view).storeys.find(r => r.expressId === id)!.GlobalId;

for (const binding of ['explicit', 'relative'] as const) {
  it.each([false, true])(`#9352 a ${binding} copy uses floor frames when Elevation differs (reopen=%s)`, async reopen => {
    let { s, home, middle, upper, wall } = await setup(binding === 'relative' ? 3 : 6);
    s.editor.setPositionalAttribute(middle, 9, { real: 2.75 });
    writeTopAttachment(s.view, wall, guid(s, binding === 'relative' ? middle : upper), binding);
    if (reopen) s = session(await parse(s.text()));
    const [copy] = copyBatchInStore(s.store, s.editor, [wall], [{ targetStoreyId: middle }]);
    if (reopen && binding === 'explicit') {
      // A loaded file body is shared by the copy. Keep the existing refusal
      // contract rather than resizing the source through its copy (#8447).
      expect(height(s, copy.copyId)).toBeCloseTo(6, 8);
      expect(copy.unattachedTops).toEqual([expect.objectContaining({ copyId: copy.copyId, reason: expect.stringMatching(/shares.*shape/) })]);
      expect(readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId)).toBeNull();
    } else {
      expect(height(s, copy.copyId)).toBeCloseTo(3, 8);
      expect(s.worldZ(copy.copyId) + height(s, copy.copyId)).toBeCloseTo(s.worldZ(upper), 8);
      expect(readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId)?.targetStoreyId).toBe(upper);
    }
    s = session(await parse(s.text()));
    expect(height(s, copy.copyId)).toBeCloseTo(reopen && binding === 'explicit' ? 6 : 3, 8);
    expect(home).not.toBe(middle);
  });
  it(`#9352 a vertically offset ${binding} copy on the same storey refits`, async () => {
    let { s, home, middle, upper, wall } = await setup();
    s.editor.removeEntity(middle);
    writeTopAttachment(s.view, wall, guid(s, upper), binding);
    const [copy] = copyBatchInStore(s.store, s.editor, [wall], [{ targetStoreyId: home, offset: [0, 2, 1] }]);
    expect(height(s, copy.copyId)).toBeCloseTo(5, 8);
    expect(s.worldZ(copy.copyId) + height(s, copy.copyId)).toBeCloseTo(6, 8);
    s = session(await parse(s.text()));
    expect(s.worldZ(copy.copyId) + height(s, copy.copyId)).toBeCloseTo(6, 8);
  });
}

it('#9352 an inserted storey rebinds from the actual old floor frame', async () => {
  let { s, home, upper, wall } = await setup();
  // Remove the unused middle storey so Ground's next is Upper. Its saved
  // elevation differs from its physical floor; the new floor follows Ground.
  const inventory = readStoreyInventory(s.store, s.view);
  const middle = inventory.storeys.find(r => r.Name === 'Middle')!.expressId;
  s.editor.removeEntity(middle);
  s.editor.setPositionalAttribute(upper, 9, { real: 5.75 });
  writeTopAttachment(s.view, wall, guid(s, upper), 'relative');
  const plan = planStoreyAdd(readStoreyInventory(s.store, s.view), { Name: 'Inserted', Elevation: 3, referenceStoreyId: home });
  expect(plan.refusal).toBeNull();
  expect(plan.bindings.find(b => b.elementId === wall)?.to).toBeCloseTo(3, 8);
  const added = addStoreyInStore(s.store, s.editor, { Name: 'Inserted', Elevation: 3, referenceStoreyId: home });
  expect(s.worldZ(wall) + height(s, wall)).toBeCloseTo(s.worldZ(added.storeyId), 8);
  s = session(await parse(s.text()));
  expect(s.worldZ(wall) + height(s, wall)).toBeCloseTo(s.worldZ(added.storeyId), 8);
});

it('#9352 a hierarchy-only home identifies a legacy relative binding without resurrecting a detached containment', async () => {
  const { s, home, middle, wall } = await setup(3);
  // A contained assembly supplies the child's parsed hierarchy; the child
  // has no direct containment of its own.
  const inventory = readStoreyInventory(s.store, s.view);
  for (const rel of inventory.incoming.get(wall) ?? []) s.editor.removeEntity(rel.id);
  const placement = new AnchorEntityReader(s.store, s.view).entity(wall)!.attributes[5];
  if (typeof placement !== 'string' && typeof placement !== 'number') throw new Error('The fixture wall needs a placement reference');
  const parent = s.editor.addEntity('IfcElementAssembly', ['0000000000000000000001', null, 'Assembly', null, null, placement, null, null, '.SITE.', '.NOTDEFINED.']).expressId;
  s.editor.addEntity('IfcRelContainedInSpatialStructure', ['0000000000000000000002', null, null, null, [`#${parent}`], `#${home}`]);
  s.editor.addEntity('IfcRelAggregates', ['0000000000000000000003', null, null, null, `#${parent}`, [`#${wall}`]]);
  writeTopAttachment(s.view, wall, guid(s, middle));
  const saved = session(await parse(s.text()));
  const live = readStoreyInventory(saved.store, saved.view);
  expect(saved.store.spatialHierarchy?.elementToStorey.get(wall)).toBe(home);
  expect(homeStoreyOf(live, wall)).toBe(home);
  expect(readTopAttachment(live, wall)?.binding).toBe('relative');
  const added = addStoreyInStore(saved.store, saved.editor, { Name: 'Inserted', Elevation: 1.5, referenceStoreyId: home });
  expect(height(saved, wall)).toBeCloseTo(1.5, 8);
  const reopened = session(await parse(saved.text()));
  expect(readTopAttachment(readStoreyInventory(reopened.store, reopened.view), wall)?.targetStoreyId).toBe(added.storeyId);
  expect(height(reopened, wall)).toBeCloseTo(1.5, 8);
  // An ordinary source containment explicitly removed in the overlay must stay absent.
  const ordinary = await setup();
  for (const rel of readStoreyInventory(ordinary.s.store, ordinary.s.view).incoming.get(ordinary.wall) ?? []) ordinary.s.editor.removeEntity(rel.id);
  expect(homeStoreyOf(readStoreyInventory(ordinary.s.store, ordinary.s.view), ordinary.wall)).toBeNull();
  expect(new AnchorEntityReader(saved.store, saved.view).entity(wall)).not.toBeNull();
});


it('#9352 the next storey above skips equal-elevation siblings', async () => {
  const { s, home, middle, upper, wall } = await setup();
  s.editor.setPositionalAttribute(middle, 9, { real: 0 });
  const homePlacement = new AnchorEntityReader(s.store, s.view).entity(home)!.attributes[5];
  if (typeof homePlacement !== 'string' && typeof homePlacement !== 'number') throw new Error('The fixture storey needs a placement reference');
  s.editor.setPositionalAttribute(middle, 5, homePlacement);
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'storeyAbove' });
  expect(readTopAttachment(readStoreyInventory(s.store, s.view), wall)?.targetStoreyId).toBe(upper);
  expect(height(s, wall)).toBeCloseTo(6, 8);
});


it('#9352 an explicit top copied into another building follows physical floor frames', async () => {
  let { s, home, middle, upper, wall } = await setup();
  const inv = readStoreyInventory(s.store, s.view);
  const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 3]]).expressId;
  const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  const placement = s.editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
  const building = s.editor.addEntity('IfcBuilding', ['0000000000000000000004', null, 'Second building', null, null, `#${placement}`, null, null, '.ELEMENT.', null, null, null]).expressId;
  const zero = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const zeroAxis = s.editor.addEntity('IfcAxis2Placement3D', [`#${zero}`, null, null]).expressId;
  const floor = s.editor.addEntity('IfcLocalPlacement', [`#${placement}`, `#${zeroAxis}`]).expressId;
  for (const rel of inv.incoming.get(middle) ?? []) s.editor.setPositionalAttribute(rel.id, rel.listIndex, rel.children.filter(id => id !== middle).map(id => `#${id}`));
  s.editor.addEntity('IfcRelAggregates', ['0000000000000000000005', null, null, null, `#${building}`, [`#${middle}`]]);
  const project = inv.reader.firstId('IFCPROJECT')!;
  s.editor.addEntity('IfcRelAggregates', ['0000000000000000000006', null, null, null, `#${project}`, [`#${building}`]]);
  s.editor.setPositionalAttribute(middle, 5, `#${floor}`);
  s.editor.setPositionalAttribute(middle, 9, { real: 0 });
  writeTopAttachment(s.view, wall, guid(s, upper), 'explicit');
  const [copy] = copyBatchInStore(s.store, s.editor, [wall], [{ targetStoreyId: middle }]);
  expect(height(s, copy.copyId)).toBeCloseTo(3, 8);
  expect(s.worldZ(copy.copyId) + height(s, copy.copyId)).toBeCloseTo(6, 8);
  expect(readStoreyInventory(s.store, s.view).storeys.find(row => row.expressId === home)!.parentId).not.toBe(building);
  s = session(await parse(s.text()));
  expect(s.worldZ(copy.copyId) + height(s, copy.copyId)).toBeCloseTo(6, 8);
});


it('#9352 direct containment retains priority over an aggregate ancestor on another storey', async () => {
  const { s, home, upper, wall } = await setup();
  s.editor.addEntity('IfcRelAggregates', ['0000000000000000000007', null, null, null, `#${upper}`, [`#${wall}`]]);
  expect(homeStoreyOf(readStoreyInventory(s.store, s.view), wall)).toBe(home);
});


it.each(['beam', 'member'] as const)('#9352 a pending level %s binds its top face when the first floor is added', async kind => {
  let { s, home, middle, upper } = await setup();
  s.editor.removeEntity(middle);
  s.editor.removeEntity(upper);
  const id = addOrdinaryElementInStore(s.editor, d => resolveSpatialAnchor(s.store, home, d.getMutationView()),
    { kind, params: { Start: [0, 3, 2.5], End: [5, 3, 2.5], Width: .2, Height: .4 } });
  setTopConstraintInStore(s.store, s.editor, id, { kind: 'storeyAbove' });
  const added = addStoreyInStore(s.store, s.editor, { Name: 'First above', Elevation: 3 });
  const check = () => {
    const t = { dataStore: s.store, editor: s.editor, view: s.view };
    expect(attachedTopWorldOrigin(t, id, 'linear')! + readAttachedTop(t, id, 'linear')! + levelTopFaceAbove(t, id, 'linear')).toBeCloseTo(s.worldZ(added.storeyId), 8);
  };
  check();
  s = session(await parse(s.text()));
  check();
});

it.each(['beam', 'member'] as const)('#9352 a pending level %s copied below a floor binds its top face', async kind => {
  let { s, home, middle, upper } = await setup();
  const source = addOrdinaryElementInStore(s.editor, d => resolveSpatialAnchor(s.store, upper, d.getMutationView()),
    { kind, params: { Start: [0, 3, 2.5], End: [5, 3, 2.5], Width: .2, Height: .4 } });
  setTopConstraintInStore(s.store, s.editor, source, { kind: 'storeyAbove' });
  const [copy] = copyBatchInStore(s.store, s.editor, [source], [{ targetStoreyId: home }]);
  const check = () => {
    const t = { dataStore: s.store, editor: s.editor, view: s.view };
    expect(attachedTopWorldOrigin(t, copy.copyId, 'linear')! + readAttachedTop(t, copy.copyId, 'linear')! + levelTopFaceAbove(t, copy.copyId, 'linear')).toBeCloseTo(s.worldZ(middle), 8);
  };
  check();
  s = session(await parse(s.text()));
  check();
});

it.each([['explicit', 0], ['explicit', 1], ['relative', 0], ['relative', 1]] as const)('#9352 an unreadable %s top copied with vertical offset %s is retained only when no refit is needed', async (binding, offset) => {
  let { s, home, middle, wall } = await setup(3);
  s.editor.setPositionalAttribute(wall, 6, null);
  writeTopAttachment(s.view, wall, guid(s, middle), binding);
  const [copy] = copyBatchInStore(s.store, s.editor, [wall], [{ targetStoreyId: home, offset: [0, 2, offset] }]);
  const check = () => {
    const attachment = readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId);
    if (offset === 0) expect(attachment?.targetStoreyId).toBe(middle);
    else expect(attachment).toBeNull();
  };
  check();
  if (offset === 1) expect(copy.unattachedTops).toEqual([{ copyId: copy.copyId, reason: expect.stringMatching(/body cannot be read/) }]);
  s = session(await parse(s.text()));
  check();
});

it.each([false, true])('#9352 an unreadable bound copy cannot prove a pending fit on another home (reopen=%s)', async reopen => {
  let { s, home, middle, upper, wall } = await setup(3);
  s.editor.removeEntity(upper);
  writeTopAttachment(s.view, wall, guid(s, middle), 'relative');
  s.editor.setPositionalAttribute(wall, 6, null);
  if (reopen) s = session(await parse(s.text()));
  const [copy] = copyBatchInStore(s.store, s.editor, [wall], [{ targetStoreyId: middle, offset: [0, 2, -3] }]);
  expect(s.worldZ(copy.copyId) - s.worldZ(wall)).toBeCloseTo(0, 8);
  expect(home).not.toBe(middle);
  const check = () => expect(readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId)).toBeNull();
  check();
  expect(copy.unattachedTops).toEqual([{ copyId: copy.copyId, reason: expect.stringMatching(/body cannot be read/) }]);
  s = session(await parse(s.text()));
  check();
});

for (const kind of ['wall', 'column', 'beam', 'member'] as const) {
  it.each([false, true])(`#9352 a pending unreadable ${kind} copy needs a proven unchanged height (reopen=%s)`, async reopen => {
    let { s, home, middle, upper, wall } = await setup(3);
    s.editor.removeEntity(middle);
    s.editor.removeEntity(upper);
    const source = kind === 'wall' ? wall : addOrdinaryElementInStore(s.editor,
      draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
      kind === 'column' ? { kind, params: { Position: [0, 3, 0], Width: .3, Depth: .3, Height: 3 } }
        : { kind, params: { Start: [0, 3, 0], End: [0, 3, 3], Width: .3, Height: .3 } });
    setTopConstraintInStore(s.store, s.editor, source, { kind: 'storeyAbove' });
    s.editor.setPositionalAttribute(source, 6, null);
    if (reopen) s = session(await parse(s.text()));
    const [level, shifted] = copyBatchInStore(s.store, s.editor, [source], [
      { targetStoreyId: home, offset: [0, 2, 0] }, { targetStoreyId: home, offset: [0, 4, 1] },
    ]);
    expect(s.worldZ(shifted.copyId) - s.worldZ(source)).toBeCloseTo(1, 8);
    const check = () => {
      const inventory = readStoreyInventory(s.store, s.view);
      expect(readTopAttachment(inventory, level.copyId)).toMatchObject({ binding: 'relative', targetStoreyId: null });
      expect(readTopAttachment(inventory, shifted.copyId)).toBeNull();
      expect(readTopAttachment(inventory, source)).toMatchObject({ binding: 'relative', targetStoreyId: null });
    };
    check();
    expect(level.unattachedTops).toBeUndefined();
    expect(shifted.unattachedTops).toEqual([{ copyId: shifted.copyId, reason: expect.stringMatching(/body cannot be read/) }]);
    s = session(await parse(s.text()));
    check();
    addStoreyInStore(s.store, s.editor, { Name: 'First above', Elevation: 3 });
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), shifted.copyId)).toBeNull();
    s = session(await parse(s.text()));
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), shifted.copyId)).toBeNull();
  });
}


it('#9352 the shared attached-top writer updates existing wall quantities with the body', async () => {
  let { s, wall } = await setup(3);
  s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
  s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'GrossVolume', 2.4, QuantityType.Volume);
  const outcome = writeAttachedTop({ dataStore: s.store, editor: s.editor, view: s.view }, wall, 'wall', 3, 6);
  expect(outcome.ok).toBe(true);
  const check = () => {
    const quantities = s.view.getQuantitiesForEntity(wall, id => extractQuantitiesOnDemand(s.store, id));
    expect(quantities.find(q => q.name === 'Qto_WallBaseQuantities')?.quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(6, 8);
    expect(quantities.find(q => q.name === 'Qto_WallBaseQuantities')?.quantities.find(q => q.name === 'GrossVolume')?.value).toBeCloseTo(4.8, 8);
    expect(height(s, wall)).toBeCloseTo(6, 8);
  };
  check();
  s = session(await parse(s.text()));
  check();
});


it.each(['column', 'beam', 'member'] as const)('#9352 unreadable %s copies use their product placement to decide whether a refit is needed', async kind => {
  const { s, home, middle } = await setup();
  const source = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
    kind === 'column' ? { kind, params: { Position: [0, 3, 0], Width: .3, Depth: .3, Height: 3 } }
      : { kind, params: { Start: [0, 3, 0], End: [0, 3, 3], Width: .3, Height: .3 } });
  s.editor.setPositionalAttribute(source, 6, null);
  const expected: Array<{ id: number; binding: 'relative' | 'explicit'; attached: boolean }> = [];
  for (const binding of ['relative', 'explicit'] as const) {
    writeTopAttachment(s.view, source, guid(s, middle), binding);
    for (const offset of [0, 1]) {
      const [copy] = copyBatchInStore(s.store, s.editor, [source], [{ targetStoreyId: home, offset: [0, 2, offset] }]);
      expected.push({ id: copy.copyId, binding, attached: offset === 0 });
      const attachment = readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId);
      if (offset === 0) expect(attachment).toMatchObject({ targetStoreyId: middle, binding });
      else {
        expect(attachment).toBeNull();
        expect(copy.unattachedTops).toEqual([expect.objectContaining({ copyId: copy.copyId })]);
      }
    }
  }
  const reopened = session(await parse(s.text()));
  for (const row of expected) {
    const attachment = readTopAttachment(readStoreyInventory(reopened.store, reopened.view), row.id);
    if (row.attached) expect(attachment).toMatchObject({ targetStoreyId: middle, binding: row.binding });
    else expect(attachment).toBeNull();
  }
});


it.each([[false, 0], [false, 1], [true, 1]] as const)('#9352 unreadable slab-bound copies retain only a proven unchanged gap (copySlab=%s, offset=%s)', async (copySlab, offset) => {
  let { s, home, wall } = await setup(3);
  const slab = addSlabToStore(s.editor, resolveSpatialAnchor(s.store, home, s.view),
    { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .3 }).slabId;
  s.editor.setPositionalAttribute(wall, 6, null);
  writeTopAttachment(s.view, wall, String(new AnchorEntityReader(s.store, s.view).entity(slab)!.attributes[0]), 'explicit');
  const results = copyBatchInStore(s.store, s.editor, copySlab ? [wall, slab] : [wall], [{ targetStoreyId: home, offset: [0, 2, offset] }]);
  const copy = results.find(r => r.copiedFrom.get(r.copyId) === wall)!;
  const target = results.find(r => r.copiedFrom.get(r.copyId) === slab)?.copyId ?? slab;
  const check = () => {
    const attachment = readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId);
    if (copySlab || offset === 0) expect(attachment).toMatchObject({ targetElementId: target });
    else expect(attachment).toBeNull();
  };
  check();
  s = session(await parse(s.text()));
  check();
});
