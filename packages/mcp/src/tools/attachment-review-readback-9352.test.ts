/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { readStoreyInventory } from '@ifc-lite/create';
import { loadIfcModelFromBytes } from '../loader.js';
import { liveToolSession } from '../test/live-tool-session.js';

it('#9352 MCP invalid self-delete returns the intended refusal and leaves readback unchanged', async () => {
  const { registry, call } = await liveToolSession(1);
  const model = registry.get('alpha')!, S = model.bim.store, home = S.listStoreyLevels('alpha')[0].expressId;
  S.addStorey('alpha', { Name: 'Upper', Elevation: 3 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'storeyAbove' } });
  const before = await call('get_entity', { express_id: wall.expressId, include: ['properties', 'quantities'] });
  const result = await call('storey_delete', { storey_express_id: home, mode: 'move', target_storey_express_id: home });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('Choose another storey');
  expect((await call('get_entity', { express_id: wall.expressId, include: ['properties', 'quantities'] })).structuredContent).toEqual(before.structuredContent);
});

it.each(['cycle', 'dangling', 'missingRoot'] as const)('#9352 MCP refuses an unreadable %s target and preserves readback after reopen', async fault => {
  const { registry, call } = await liveToolSession(1);
  const model = registry.get('alpha')!, S = model.bim.store, home = S.listStoreyLevels('alpha')[0].expressId;
  const upper = S.addStorey('alpha', { Name: 'Upper', Elevation: 3 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 1, TopConstraint: { kind: 'fixed' } });
  const placement = readStoreyInventory(model.store, model.backend.getMutationView()!).storeys.find(x => x.expressId === upper.expressId)!.placementId!;
  if (fault === 'missingRoot') S.setPositionalAttribute(upper, 5, '#999999');
  else S.setPositionalAttribute({ modelId: 'alpha', expressId: placement }, 0, `#${fault === 'cycle' ? placement : 999999}`);
  for (const reopen of [false, true]) {
    if (reopen) {
      const bytes = model.bim.export.ifc();
      registry.remove('alpha');
      registry.add(await loadIfcModelFromBytes(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, 'reopened.ifc', 'alpha'));
    }
    const before = await call('get_entity', { express_id: wall.expressId, include: ['properties', 'quantities'] });
    const result = await call('set_top_constraint', { express_id: wall.expressId, constraint: { kind: 'storey', storeyId: upper.expressId } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/placement.*cannot be read|unreadable.*placement/i);
    expect((await call('get_entity', { express_id: wall.expressId, include: ['properties', 'quantities'] })).structuredContent).toEqual(before.structuredContent);
  }
});

it('#9352 MCP copies a footprint-roof-bound wall and reads its reopened target and cut', async () => {
  const { registry, call } = await liveToolSession(1);
  const model = registry.get('alpha')!, S = model.bim.store, home = S.listStoreyLevels('alpha')[0].expressId;
  const roof = S.addRoof('alpha', home, { Position: [0, 20, 4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Overhang: .5 });
  const wall = S.addWall('alpha', home, { Start: [5, 20, 0], End: [5, 26, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'fixed' } });
  S.setTopConstraint(wall, { kind: 'roof', roofId: roof.expressId });
  const result = await call('copy_elements', { express_ids: [wall.expressId], transforms: [{ targetStoreyId: home, offset: [0, 1, 0] }] });
  expect(result.isError).not.toBe(true);
  const [copy] = result.structuredContent!.entities as Array<{ expressId: number }>;
  const bytes = model.bim.export.ifc();
  registry.remove('alpha');
  registry.add(await loadIfcModelFromBytes(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, 'reopened.ifc', 'alpha'));
  const read = await call('get_entity', { express_id: copy.expressId, include: ['properties'] });
  expect(read.structuredContent?.properties).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'IfcLite_StoreyAttachment', properties: expect.arrayContaining([expect.objectContaining({ name: 'TopConstraint', value: model.bim.entity(roof)!.globalId })]) }),
    expect.objectContaining({ name: 'IfcLite_RoofAttachment', properties: expect.arrayContaining([expect.objectContaining({ name: 'Clipped', value: true })]) }),
  ]));
});
