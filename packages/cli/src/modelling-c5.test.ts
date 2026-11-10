/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator, rectangularGridAxes, planBoxOf, roomFramePlanOffsets, roomFrameToModelWorld } from '@ifc-lite/create';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { loadInlineModel, exportStep } from './headless-test-helpers.js';
async function setup() {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  return { bim: await loadInlineModel(creator.toIfc().content), level };
}
async function boxes(bim: Awaited<ReturnType<typeof loadInlineModel>>, ids: number[]) {
  const processor = new GeometryProcessor({ enableInstancing: false });
  try {
    await processor.init();
    const { meshes, coordinateInfo } = await processor.process(new TextEncoder().encode(exportStep(bim)));
    const { cx, cy } = roomFramePlanOffsets(coordinateInfo), { dx, dy } = roomFrameToModelWorld(coordinateInfo);
    return ids.map(id => planBoxOf(meshes, id, { renderToLocal: ([x, y, z]) => [x + cx + dx, -z + cy + dy, y] })!);
  } finally { processor.dispose(); }
}
it('#9296 C5 aligns native wall edges in the headless CLI', async () => {
  const { bim, level } = await setup();
  const a = bim.store.addWall('default', level, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .4, Height: 3 });
  const b = bim.store.addWall('default', level, { Start: [0, 1, 0], End: [4, 1, 0], Thickness: 1, Height: 3 });
  await bim.store.alignElements('default', a.expressId, [b.expressId], 'bottom');
  const [reference, target] = await boxes(bim, [a.expressId, b.expressId]);
  expect(target.min[1]).toBeCloseTo(reference.min[1], 4);
});
it('#9296 C5 moves a grid while preserving bound columns', async () => {
  const { bim, level } = await setup();
  const grid = bim.store.addGrid('default', level, rectangularGridAxes({ UOffsets: [0, 5], VOffsets: [0, 4], UTags: ['A', 'B'], VTags: ['1', '2'] }));
  const axes = bim.query().byType('IfcGridAxis').toArray();
  const axis = (tag: string) => axes.find(a => bim.attributes(a.ref).some(v => v.name === 'AxisTag' && v.value === tag))!.ref.expressId;
  const column = bim.store.addColumnOnGrid('default', level, { Position: [5, 4, 0], Width: .4, Depth: .4, Height: 3 }, { GridId: grid.expressId, IntersectingAxes: [axis('B'), axis('2')] });
  bim.store.transformElements('default', [grid.expressId], { kind: 'move', delta: [1, 0] });
  const [box] = await boxes(bim, [column.expressId]);
  expect((box.min[0] + box.max[0]) / 2).toBeCloseTo(6, 3);
});
it('#9296 C5 joins a chain as it is drawn', async () => {
  const { bim, level } = await setup();
  for (const [Start, End] of [[[0, 0, 0], [4, 0, 0]], [[4, 0, 0], [4, 3, 0]], [[4, 3, 0], [0, 3, 0]], [[0, 3, 0], [0, 0, 0]]] as Array<[[number, number, number], [number, number, number]]>) {
    bim.store.addWall('default', level, { Start, End, Thickness: .2, Height: 3 });
  }
  expect(exportStep(bim).match(/=IFCRELCONNECTSPATHELEMENTS\(/g)).toHaveLength(4);
});
