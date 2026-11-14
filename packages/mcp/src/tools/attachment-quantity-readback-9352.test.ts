/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
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
