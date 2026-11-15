/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openModel } from '../headless.js';

const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

it('#9352 SDK invalid self-delete preview remains a structured refusal through reopen', async () => {
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const S = model.bim.store, home = S.listStoreyLevels('m')[0].expressId;
    S.addStorey('m', { Name: 'Upper', Elevation: 3 });
    const wall = S.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'storeyAbove' } });
    const check = (bim: typeof model.bim) => {
      const before = { levels: bim.store.listStoreyLevels('m'), properties: bim.properties(wall), quantities: bim.quantities(wall) };
      expect(bim.store.planStoreyDelete({ modelId: 'm', expressId: home }, { kind: 'move', targetStoreyId: home }).refusals)
        .toEqual([expect.objectContaining({ code: 'invalidTarget' })]);
      expect({ levels: bim.store.listStoreyLevels('m'), properties: bim.properties(wall), quantities: bim.quantities(wall) }).toEqual(before);
    };
    check(model.bim);
    const bytes = model.bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});

it.each(['cycle', 'dangling', 'missingRoot'] as const)('#9352 SDK refuses an unreadable %s floor without changing the wall, including reopen', async fault => {
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const S = model.bim.store, home = S.listStoreyLevels('m')[0].expressId;
    const upper = S.addStorey('m', { Name: 'Upper', Elevation: 3 });
    const wall = S.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 1, TopConstraint: { kind: 'fixed' } });
    if (fault === 'missingRoot') S.setPositionalAttribute(upper, 5, '#999999');
    else {
      const point = S.addEntity('m', { type: 'IfcCartesianPoint', attributes: [[0, 0, 3]] });
      const axis = S.addEntity('m', { type: 'IfcAxis2Placement3D', attributes: [`#${point.expressId}`, null, null] });
      const placement = S.addEntity('m', { type: 'IfcLocalPlacement', attributes: [null, `#${axis.expressId}`] });
      S.setPositionalAttribute(placement, 0, `#${fault === 'cycle' ? placement.expressId : 999999}`);
      S.setPositionalAttribute(upper, 5, `#${placement.expressId}`);
    }
    const check = (bim: typeof model.bim) => {
      const before = { properties: bim.properties(wall), quantities: bim.quantities(wall) };
      expect(() => bim.store.setTopConstraint(wall, { kind: 'storey', storeyId: upper.expressId })).toThrow(/placement.*cannot be read|unreadable.*placement/i);
      expect({ properties: bim.properties(wall), quantities: bim.quantities(wall) }).toEqual(before);
    };
    check(model.bim);
    const bytes = model.bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});

it('#9352 SDK copy of a footprint-roof-bound wall keeps its target and cut through reopen', async () => {
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const S = model.bim.store, home = S.listStoreyLevels('m')[0].expressId;
    const roof = S.addRoof('m', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 });
    const wall = S.addWall('m', home, { Start: [5, 20, 0], End: [5, 26, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'fixed' } });
    S.setTopConstraint(wall, { kind: 'roof', roofId: roof.expressId });
    const [copy] = S.copyElements('m', [wall.expressId], [{ targetStoreyId: home, offset: [0, 1, 0] }]);
    const check = (bim: typeof model.bim) => {
      expect(bim.properties(copy).find(p => p.name === 'IfcLite_StoreyAttachment')?.properties.find(p => p.name === 'TopConstraint')?.value).toBe(model.bim.entity(roof)!.globalId);
      expect(bim.properties(copy).find(p => p.name === 'IfcLite_RoofAttachment')?.properties.find(p => p.name === 'Clipped')?.value).toBe(true);
      expect(bim.quantities(copy).flatMap(q => q.quantities).some(q => q.name === 'NetVolume')).toBe(false);
    };
    check(model.bim);
    const bytes = model.bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});

it.each(['cycle', 'dangling', 'missingRoot'] as const)('#9352 SDK deletion preview returns an unreadable %s floor refusal through reopen', async fault => {
  const model = await openModel(readFileSync(sample), { modelId: 'm', disableWorkerScan: true });
  try {
    const S = model.bim.store, home = S.listStoreyLevels('m')[0].expressId;
    const middle = S.addStorey('m', { Name: 'Middle', Elevation: 3 });
    const upper = S.addStorey('m', { Name: 'Upper', Elevation: 6 });
    const wall = S.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'storeyAbove' } });
    if (fault === 'missingRoot') S.setPositionalAttribute(upper, 5, '#999999');
    else {
      const point = S.addEntity('m', { type: 'IfcCartesianPoint', attributes: [[0, 0, 6]] });
      const axis = S.addEntity('m', { type: 'IfcAxis2Placement3D', attributes: [`#${point.expressId}`, null, null] });
      const placement = S.addEntity('m', { type: 'IfcLocalPlacement', attributes: [null, `#${axis.expressId}`] });
      S.setPositionalAttribute(placement, 0, `#${fault === 'cycle' ? placement.expressId : 999999}`);
      S.setPositionalAttribute(upper, 5, `#${placement.expressId}`);
    }
    const check = (bim: typeof model.bim) => {
      const before = { levels: bim.store.listStoreyLevels('m'), properties: bim.properties(wall), quantities: bim.quantities(wall) };
      const plan = bim.store.planStoreyDelete(middle, { kind: 'empty' });
      expect(plan.refusals).toEqual([expect.objectContaining({ code: 'unreadablePlacement' })]);
      expect(() => bim.store.deleteStorey(middle, { kind: 'empty' }, plan)).toThrow(/placement.*cannot be read/i);
      expect({ levels: bim.store.listStoreyLevels('m'), properties: bim.properties(wall), quantities: bim.quantities(wall) }).toEqual(before);
    };
    check(model.bim);
    const bytes = model.bim.export.ifc();
    const reopened = await openModel(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, { modelId: 'm', disableWorkerScan: true });
    try { check(reopened.bim); } finally { reopened.close(); }
  } finally { model.close(); }
});
