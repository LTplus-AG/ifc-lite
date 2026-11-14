/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '../../ifc-creator.js';
import { addOrdinaryElementInStore } from '../ordinary-element.js';
import { addHostedElementInStore } from '../hosted-element.js';
import { resolveSpatialAnchor } from '../resolve-anchor.js';
import { readStoreyInventory } from './storey-model.js';
import { addStoreyInStore } from './storey-add.js';
import { applyStoreyDelete, planStoreyDelete } from './storey-delete.js';
import { readTopAttachment, writeTopAttachment, NEXT_STOREY_ABOVE } from './storey-attachment.js';
import { readAttachedTop } from './storey-attached.js';
import { parse, session } from '../__test__/storey-fixtures.oracle.js';

it.each([false, true])('#9352 deleting the next storey rebinds relatively and preserves the top offset (reopen=%s)', async reopen => {
  const creator = new IfcCreator({ Name: 'Delete storey' });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  let s = session(await parse(creator.toIfc().content));
  const home = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const middle = addStoreyInStore(s.store, s.editor, { Name: 'Middle', Elevation: 3 }).storeyId;
  const upper = addStoreyInStore(s.store, s.editor, { Name: 'Upper', Elevation: 6 }).storeyId;
  const storeys = readStoreyInventory(s.store, s.view).storeys;
  const middleGuid = storeys.find(x => x.expressId === middle)!.GlobalId;
  const upperGuid = storeys.find(x => x.expressId === upper)!.GlobalId;
  const make = (y: number) => addOrdinaryElementInStore(s.editor,
    draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, y, 0], End: [5, y, 0], Thickness: .2, Height: 2.8 } });
  const relative = make(0), explicit = make(2);
  writeTopAttachment(s.view, relative, middleGuid, 'relative');
  writeTopAttachment(s.view, explicit, middleGuid, 'explicit');
  if (reopen) s = session(await parse(s.text()));
  applyStoreyDelete(s.store, s.editor, middle, { kind: 'empty' });
  const check = () => {
    const inventory = readStoreyInventory(s.store, s.view);
    expect(readTopAttachment(inventory, relative)?.targetStoreyId).toBe(upper);
    expect(s.view.getPropertyValue(relative, 'IfcLite_StoreyAttachment', 'TopConstraint')).toBe(upperGuid);
    expect(readTopAttachment(inventory, explicit)).toBeNull();
    expect(readAttachedTop({ dataStore: s.store, view: s.view, editor: s.editor }, relative, 'wall')).toBeCloseTo(5.8, 8);
  };
  check();
  s = session(await parse(s.text()));
  check();
  applyStoreyDelete(s.store, s.editor, upper, { kind: 'empty' });
  expect(s.view.getPropertyValue(relative, 'IfcLite_StoreyAttachment', 'TopConstraint')).toBe(NEXT_STOREY_ABOVE);
});


it.each([false, true])('#9352 moving a deleted home rebinds from the destination home (reopen=%s)', async reopen => {
  const creator = new IfcCreator({ Name: 'Delete home' });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  let s = session(await parse(creator.toIfc().content));
  const home = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const upper = addStoreyInStore(s.store, s.editor, { Name: 'Upper', Elevation: 3 }).storeyId;
  const wall = addOrdinaryElementInStore(s.editor,
    draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, 0, 0], End: [5, 0, 0], Thickness: .2, Height: 2.8 } });
  const upperGuid = readStoreyInventory(s.store, s.view).storeys.find(x => x.expressId === upper)!.GlobalId;
  writeTopAttachment(s.view, wall, upperGuid, 'relative');
  if (reopen) s = session(await parse(s.text()));
  applyStoreyDelete(s.store, s.editor, home, { kind: 'move', targetStoreyId: upper });
  expect(s.view.getPropertyValue(wall, 'IfcLite_StoreyAttachment', 'TopConstraint')).toBe(NEXT_STOREY_ABOVE);
  s = session(await parse(s.text()));
  expect(readTopAttachment(readStoreyInventory(s.store, s.view), wall)).toMatchObject({ targetStoreyId: null, binding: 'relative' });
});

it.each([false, true])('#9352 a pending relative top moved below its physical base is refused by the read-only plan (reopen=%s)', async reopen => {
  const creator = new IfcCreator({ Name: 'Pending relative top' });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  let s = session(await parse(creator.toIfc().content));
  const lower = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  addStoreyInStore(s.store, s.editor, { Name: 'Middle', Elevation: 3 });
  const home = addStoreyInStore(s.store, s.editor, { Name: 'Top', Elevation: 6 }).storeyId;
  const wall = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, 0, 0], End: [5, 0, 0], Thickness: .2, Height: 2.8 } });
  writeTopAttachment(s.view, wall, NEXT_STOREY_ABOVE, 'relative');
  if (reopen) s = session(await parse(s.text()));
  const before = s.snapshot();
  const plan = planStoreyDelete(readStoreyInventory(s.store, s.view), home, { kind: 'move', targetStoreyId: lower });
  expect(plan.refusals).toEqual([expect.objectContaining({ code: 'dependent', elementIds: [wall] })]);
  expect(plan.refusals[0].message).toMatch(/top|height|tall/i);
  expect(s.snapshot()).toEqual(before);
  expect(() => applyStoreyDelete(s.store, s.editor, home, { kind: 'move', targetStoreyId: lower })).toThrow(/top|height|tall/i);
  expect(s.snapshot()).toEqual(before);
});


it.each([false, true])('#9352 deletion preview refuses a positive refit that would cut a hosted opening (reopen=%s)', async reopen => {
  const creator = new IfcCreator({ Name: 'Opening refit' });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  let s = session(await parse(creator.toIfc().content));
  const lower = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  addStoreyInStore(s.store, s.editor, { Name: 'Middle', Elevation: 3 });
  const home = addStoreyInStore(s.store, s.editor, { Name: 'Top', Elevation: 6 }).storeyId;
  const wall = addOrdinaryElementInStore(s.editor, draft => resolveSpatialAnchor(s.store, home, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, 0, -6], End: [5, 0, -6], Thickness: .2, Height: 4 } });
  addHostedElementInStore(s.store, s.editor, wall, { kind: 'door', params: { Offset: 1, Width: .9, Height: 3.5 } });
  writeTopAttachment(s.view, wall, NEXT_STOREY_ABOVE, 'relative');
  if (reopen) s = session(await parse(s.text()));
  const before = s.snapshot();
  const mode = { kind: 'move' as const, targetStoreyId: lower };
  const plan = planStoreyDelete(readStoreyInventory(s.store, s.view), home, mode);
  expect(plan.refusals).toEqual([expect.objectContaining({ code: 'dependent', elementIds: [wall] })]);
  expect(plan.refusals[0].message).toMatch(/opening|door|top/i);
  expect(s.snapshot()).toEqual(before);
  expect(() => applyStoreyDelete(s.store, s.editor, home, mode, plan)).toThrow(/opening|door|top/i);
  expect(s.snapshot()).toEqual(before);
});
