/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { liveToolSession } from '../test/live-tool-session.js';

it('#9352 MCP reports and reads an unreadable pending copy as detached through reopen and storey add', async () => {
  const { registry, call } = await liveToolSession(1);
  const model = registry.get('alpha')!, S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3,
    TopConstraint: { kind: 'storeyAbove' } });
  S.setPositionalAttribute(wall, 6, null);
  const result = await call('copy_elements', { express_ids: [wall.expressId], transforms: [{ targetStoreyId: home, offset: [0, 2, 1] }] });
  expect(result.isError).not.toBe(true);
  const [copy] = result.structuredContent!.entities as Array<{ expressId: number }>;
  const check = async () => {
    const readback = await call('get_entity', { express_id: copy.expressId, include: ['properties'] });
    expect(readback.isError).not.toBe(true);
    const sets = readback.structuredContent!.properties as Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>;
    expect(sets.find(p => p.name === 'IfcLite_StoreyAttachment')?.properties.find(p => p.name === 'TopConstraint')?.value).toBeUndefined();
    const exported = model.bim.export.ifc();
    const bytes = typeof exported === 'string' ? new TextEncoder().encode(exported) : exported;
    const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(extractPropertiesOnDemand(reopened, copy.expressId).find(p => p.name === 'IfcLite_StoreyAttachment')?.properties
      .find(p => p.name === 'TopConstraint')?.value).toBeUndefined();
  };
  await check();
  expect(result.structuredContent!.unattachedTops).toEqual([{ expressId: copy.expressId, reason: expect.stringMatching(/body cannot be read/) }]);
  expect((await call('storey_add', { Name: 'First above', Elevation: 3 })).isError).not.toBe(true);
  await check();
});
