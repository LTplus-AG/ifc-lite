/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { liveToolSession } from '../test/live-tool-session.js';

it.each([false, true])('#9352 MCP quantity readback follows the final roof cut (pitched=%s)', async pitched => {
  const { registry, call } = await liveToolSession(1);
  const model = registry.get('alpha')!, S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const roof = S.addRoof('alpha', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25,
    ...(pitched ? { EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 } : {}) });
  const wall = S.addWall('alpha', home, { Start: [5, 20, 0], End: [5, 28, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'fixed' } });
  S.setTopConstraint(wall, { kind: 'roof', roofId: roof.expressId });
  const result = await call('get_entity', { express_id: wall.expressId, include: ['quantities'] });
  expect(result.isError).not.toBe(true);
  const sets = result.structuredContent!.quantities as Array<{ name: string; quantities: Array<{ name: string; value: number }> }>;
  const quantities = sets.find(set => set.name === 'Qto_WallBaseQuantities')!.quantities;
  if (pitched) expect(quantities.some(q => ['Height', 'GrossVolume', 'NetVolume'].includes(q.name))).toBe(false);
  else expect(quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(4, 8);
});


it.each(['roof', 'storey'] as const)('#9352 MCP reads correct pitched-to-%s quantities through export and reopen', async kind => {
  const { registry, call } = await liveToolSession(1);
  const model = registry.get('alpha')!, S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const above = S.addStorey('alpha', { Name: 'Above', Elevation: 4 });
  const pitched = S.addRoof('alpha', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 });
  const flat = S.addRoof('alpha', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25 });
  const wall = S.addWall('alpha', home, { Start: [5, 20, 0], End: [5, 28, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'fixed' } });
  const view = model.backend.getMutationView()!;
  view.setQuantity(wall.expressId, 'Qto_WallBaseQuantities', 'Height', 3, QuantityType.Length);
  view.setQuantity(wall.expressId, 'Qto_WallBaseQuantities', 'GrossVolume', 4.8, QuantityType.Volume);
  expect((await call('set_top_constraint', { express_id: wall.expressId, constraint: { kind: 'roof', roofId: pitched.expressId } })).isError).not.toBe(true);
  expect((await call('set_top_constraint', { express_id: wall.expressId, constraint: kind === 'roof' ? { kind: 'roof', roofId: flat.expressId } : { kind: 'storey', storeyId: above.expressId } })).isError).not.toBe(true);
  const result = await call('get_entity', { express_id: wall.expressId, include: ['quantities'] });
  expect(result.isError).not.toBe(true);
  const sets = result.structuredContent!.quantities as Array<{ name: string; quantities: Array<{ name: string; value: number }> }>;
  const check = (quantities: Array<{ name: string; value: number }>) => {
    expect(quantities.find(q => q.name === 'Height')?.value).toBeCloseTo(4, 8);
    expect(quantities.find(q => q.name === 'GrossVolume')?.value).toBeCloseTo(6.4, 8);
  };
  check(sets.find(set => set.name === 'Qto_WallBaseQuantities')!.quantities);
  const output = model.bim.export.ifc(), bytes = typeof output === 'string' ? new TextEncoder().encode(output) : output;
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  check(extractQuantitiesOnDemand(reopened, wall.expressId).find(set => set.name === 'Qto_WallBaseQuantities')!.quantities);
});
