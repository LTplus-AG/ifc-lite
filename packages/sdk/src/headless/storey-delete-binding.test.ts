/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openModel } from '../headless.js';

it('#9352 SDK deletion readback records the new relative target, including after reopen', async () => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const { bim } = model, S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const middle = S.addStorey('m', { Name: 'Middle', Elevation: 3 });
    const upper = S.addStorey('m', { Name: 'Upper', Elevation: 6 });
    const upperGuid = bim.entity(upper)!.globalId;
    const wall = S.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'storeyAbove' } });
    S.deleteStorey(middle, { kind: 'empty' });
    const check = (context: typeof bim) => {
      expect(context.properties(wall).find(p => p.name === 'IfcLite_StoreyAttachment')
        ?.properties.find(p => p.name === 'TopConstraint')?.value).toBe(upperGuid);
      const quantities = context.quantities(wall).find(q => q.name === 'Qto_WallBaseQuantities')?.quantities;
      expect(quantities?.find(q => q.name === 'Height')?.value).toBeCloseTo(6, 8);
      expect(quantities?.find(q => q.name === 'NetVolume')?.value).toBeCloseTo(4.8, 8);
    };
    check(bim);
    const content = bim.export.ifc();
    const reopened = await openModel(typeof content === 'string' ? new TextEncoder().encode(content) : content,
      { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});


it.each([false, true])('#9352 SDK deletion preview reports an impossible pending top before and after reopening (opening=%s)', async withOpening => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const S = model.bim.store;
    const lower = S.listStoreyLevels('m')[0].expressId;
    S.addStorey('m', { Name: 'Middle', Elevation: 3 });
    const home = S.addStorey('m', { Name: 'Top', Elevation: 6 });
    const z = withOpening ? -6 : 0;
    const wall = S.addWall('m', home.expressId, { Start: [0, 5, z], End: [4, 5, z], Thickness: .2, Height: withOpening ? 4 : 3,
      TopConstraint: { kind: 'storeyAbove' } });
    if (withOpening) S.addHostedDoor('m', wall.expressId, { Offset: 1, Width: .9, Height: 3.5 });
    const check = (context: typeof model.bim) => {
      const snapshot = () => ({ levels: context.store.listStoreyLevels('m'), properties: context.properties(wall), quantities: context.quantities(wall) });
      const before = snapshot();
      const plan = context.store.planStoreyDelete(home, { kind: 'move', targetStoreyId: lower });
      expect(plan.refusals).toEqual([expect.objectContaining({ code: 'dependent', elementIds: [wall.expressId] })]);
      expect(snapshot()).toEqual(before);
    };
    check(model.bim);
    const content = model.bim.export.ifc();
    const reopened = await openModel(typeof content === 'string' ? new TextEncoder().encode(content) : content,
      { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});
