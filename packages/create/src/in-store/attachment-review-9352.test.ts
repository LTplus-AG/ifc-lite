/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { addRoofToStore } from './roof.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addStoreyInStore } from './storey/storey-add.js';
import { setTopConstraintInStore } from './storey/storey-top-constraint.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { readTopAttachment, writeTopAttachment } from './storey/storey-attachment.js';
import { readWallMetres } from './wall-size-edit.js';
import { parse, session } from './__test__/storey-fixtures.oracle.js';

async function fixture() {
  const creator = new IfcCreator();
  const home = creator.addIfcBuildingStorey({ Name: 'Home', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const anchor = resolveSpatialAnchor(s.store, home, s.view);
  const wall = addOrdinaryElementInStore(s.editor, anchor, { kind: 'wall', params: { Start: [5, 0, 0], End: [5, 8, 0], Height: 3, Thickness: .2 } });
  return { s, home, wall, anchor };
}

for (const reopen of [false, true]) it.each(['flat', 'storey', 'storey-envelope'] as const)(`#9352 pitched-to-%s quantities use their preserved prism baseline (reopen=${reopen})`, async kind => {
  let { s, wall, anchor } = await fixture();
  const pitched = addRoofToStore(s.editor, anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 }).roofId;
  const flat = addRoofToStore(s.editor, anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .25 }).roofId;
  const above = addStoreyInStore(s.store, s.editor, { Name: 'Above', Elevation: 4 }).storeyId;
  s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
  s.view.setQuantity(wall, 'Qto_WallBaseQuantities', 'GrossVolume', 4.8, QuantityType.Volume);
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: pitched });
  const expectedHeight = kind === 'storey-envelope'
    ? readWallMetres({ dataStore: s.store, view: s.view, editor: s.editor }, wall)!.height : 4;
  const envelopeStorey = kind === 'storey-envelope' ? addStoreyInStore(s.store, s.editor, { Name: 'Envelope', Elevation: expectedHeight }).storeyId : above;
  if (reopen) s = session(await parse(s.text()));
  setTopConstraintInStore(s.store, s.editor, wall, kind === 'flat' ? { kind: 'roof', roofId: flat } : { kind: 'storey', storeyId: envelopeStorey });
  expect(readWallMetres({ dataStore: s.store, view: s.view, editor: s.editor }, wall)!.height).toBeCloseTo(expectedHeight, 8);
  const saved = await parse(s.text());
  const quantities = extractQuantitiesOnDemand(saved, wall).find(set => set.name === 'Qto_WallBaseQuantities')!.quantities;
  expect(quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(expectedHeight, 8);
  expect(quantities.find(q => q.name === 'GrossVolume')?.value).toBeCloseTo(1.6 * expectedHeight, 8);
});

it.each([false, true])('#9352 insertion rebinds legacy relative walls on all tied lower storeys (reopen=%s)', async reopen => {
  let { s, home, wall } = await fixture();
  const tied = addStoreyInStore(s.store, s.editor, { Name: 'Tied', Elevation: 1 }).storeyId;
  const upper = addStoreyInStore(s.store, s.editor, { Name: 'Upper', Elevation: 3 }).storeyId;
  const other = addOrdinaryElementInStore(s.editor, resolveSpatialAnchor(s.store, tied, s.view), { kind: 'wall', params: { Start: [0, 10, 0], End: [4, 10, 0], Height: 2, Thickness: .2 } });
  const homePlacement = readStoreyInventory(s.store, s.view).reader.entity(home)!.attributes[5];
  s.editor.setPositionalAttribute(tied, 5, homePlacement as string | number);
  s.editor.setPositionalAttribute(tied, 9, { real: 0 });
  const globalId = readStoreyInventory(s.store, s.view).storeys.find(row => row.expressId === upper)!.GlobalId;
  for (const id of [wall, other]) writeTopAttachment(s.view, id, globalId);
  if (reopen) s = session(await parse(s.text()));
  const added = addStoreyInStore(s.store, s.editor, { Name: 'Inserted', Elevation: 1.5, referenceStoreyId: home });
  expect(added.bindings.map(binding => binding.elementId)).toEqual(expect.arrayContaining([wall, other]));
  s = session(await parse(s.text()));
  for (const id of [wall, other]) expect(readTopAttachment(readStoreyInventory(s.store, s.view), id)).toMatchObject({ binding: 'relative', targetStoreyId: added.storeyId });
});
