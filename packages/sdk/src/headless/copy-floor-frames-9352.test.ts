/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openModel, HeadlessBackend } from '../headless.js';
import { parseModel } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { createBimContext } from '../context.js';

it('#9352 SDK reports a vertically shifted unreadable pending copy and keeps it detached after reopen and storey add', async () => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const { bim } = model, S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const wall = S.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3,
      TopConstraint: { kind: 'storeyAbove' } });
    S.setPositionalAttribute(wall, 6, null);
    const [copy] = S.copyElements('m', [wall.expressId], [{ targetStoreyId: home, offset: [0, 2, 1] }]);
    const top = (context: typeof bim) => context.properties(copy).find(p => p.name === 'IfcLite_StoreyAttachment')?.properties
      .find(p => p.name === 'TopConstraint')?.value;
    expect(top(bim)).toBeUndefined();
    expect(copy.unattachedTops).toEqual([{ expressId: copy.expressId, reason: expect.stringMatching(/body cannot be read/) }]);
    expect(bim.properties(wall).find(p => p.name === 'IfcLite_StoreyAttachment')?.properties
      .find(p => p.name === 'TopConstraint')?.value).toBe('NextStoreyAbove');
    const checkReopen = async () => {
      const bytes = bim.export.ifc();
      const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
      try { expect(top(reopened.bim)).toBeUndefined(); } finally { reopened.close(); }
    };
    await checkReopen();
    S.addStorey('m', { Name: 'First above', Elevation: 3 });
    expect(top(bim)).toBeUndefined();
    await checkReopen();
  } finally { model.close(); }
});

it('#9352 SDK copy readback keeps a top on its physical target, including after reopen', async () => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const { bim } = model, S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const middle = S.addStorey('m', { Name: 'Middle', Elevation: 3 });
    const upper = S.addStorey('m', { Name: 'Upper', Elevation: 6 });
    S.setPositionalAttribute(middle, 9, { real: 2.75 });
    const wall = S.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 6,
      TopConstraint: { kind: 'storey', storeyId: upper.expressId } });
    const [copy] = S.copyElements('m', [wall.expressId], [{ targetStoreyId: middle.expressId, offset: [0, 2, .5] }]);
    const check = (context: typeof bim) => {
      expect(context.properties(copy).find(p => p.name === 'IfcLite_StoreyAttachment')?.properties.find(p => p.name === 'TopConstraint')?.value).toBe(bim.entity(upper)!.globalId);
      const height = (ref: typeof wall) => context.quantities(ref).find(q => q.name === 'Qto_WallBaseQuantities')?.quantities.find(q => q.name === 'Height')?.value;
      expect(height(copy)).toBeCloseTo(2.5, 8);
      expect(height(wall)).toBeCloseTo(6, 8);
    };
    check(bim);
    const bytes = bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});

it.each(['constraint', 'insert', 'relevel'] as const)('#9352 SDK %s refits wall quantities once and keeps them after reopen', async operation => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const { bim } = model, S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const above = operation === 'insert' ? null : S.addStorey('m', { Name: 'Above', Elevation: 6 });
    const wall = S.addWall('m', home, { Start: [0, 20, 0], End: [4, 20, 0], Thickness: .2, Height: operation === 'constraint' ? 3 : 6,
      TopConstraint: operation === 'constraint' ? { kind: 'fixed' } : { kind: 'storeyAbove' } });
    if (operation === 'constraint') S.setTopConstraint(wall, { kind: 'storey', storeyId: above!.expressId });
    else if (operation === 'insert') S.addStorey('m', { Name: 'First above', Elevation: 3 });
    else S.editStorey('m', { kind: 'floorHeight', storeyId: home, Height: 3 });
    const expected = operation === 'constraint' ? 6 : 3;
    const check = (context: typeof bim) => {
      const quantities = context.quantities(wall).find(q => q.name === 'Qto_WallBaseQuantities')!.quantities;
      expect(quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(expected, 8);
      expect(quantities.find(q => q.name === 'GrossVolume')?.value).toBeCloseTo(4 * .2 * expected, 8);
    };
    check(bim);
    const bytes = bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});

it.each([false, true])('#9352 SDK roof quantity readback respects the final cut (pitched=%s)', async pitched => {
  const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const { bim } = model, S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const roof = S.addRoof('m', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25,
      ...(pitched ? { EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 } : {}) });
    const wall = S.addWall('m', home, { Start: [5, 20, 0], End: [5, 28, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'fixed' } });
    S.setTopConstraint(wall, { kind: 'roof', roofId: roof.expressId });
    const check = (context: typeof bim) => {
      const quantities = context.quantities(wall).find(set => set.name === 'Qto_WallBaseQuantities')!.quantities;
      if (pitched) expect(quantities.some(q => ['Height', 'GrossVolume', 'NetVolume'].includes(q.name))).toBe(false);
      else expect(quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(4, 8);
    };
    check(bim);
    const bytes = bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});


it.each(['roof', 'storey'] as const)('#9352 SDK reads preserved quantities after a pitched-to-%s refit and reopen', async kind => {
  const { store } = await parseModel(readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'quantities.ifc', 'm');
  try {
    const bim = createBimContext({ backend }), S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const above = S.addStorey('m', { Name: 'Above', Elevation: 4 });
    const pitched = S.addRoof('m', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 });
    const flat = S.addRoof('m', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25 });
    const wall = S.addWall('m', home, { Start: [5, 20, 0], End: [5, 28, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'fixed' } });
    backend.getMutationView()!.setQuantity(wall.expressId, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
    backend.getMutationView()!.setQuantity(wall.expressId, 'Qto_WallBaseQuantities', 'GrossVolume', 4.8, QuantityType.Volume);
    S.setTopConstraint(wall, { kind: 'roof', roofId: pitched.expressId });
    S.setTopConstraint(wall, kind === 'roof' ? { kind: 'roof', roofId: flat.expressId } : { kind: 'storey', storeyId: above.expressId });
    const check = (context: typeof bim) => {
      const quantities = context.quantities(wall).find(set => set.name === 'Qto_WallBaseQuantities')!.quantities;
      expect(quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(4, 8);
      expect(quantities.find(q => q.name === 'GrossVolume')?.value).toBeCloseTo(6.4, 8);
    };
    check(bim);
    const bytes = bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { backend.dispose(); }
});
