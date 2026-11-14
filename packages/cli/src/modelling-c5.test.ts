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

it('#9296 C5 mirrors a wall copy with its hosted door', async () => {
  const { bim, level } = await setup();
  const wall = bim.store.addWall('default', level, { Start: [10, 1, 0], End: [13, 1, 0], Thickness: .2, Height: 3 });
  bim.store.addHostedDoor('default', wall.expressId, { Offset: 1, Width: .9, Height: 2, OperationType: 'SINGLE_SWING_LEFT' });
  const source = exportStep(bim);
  const bodyRep = source.match(/#(\d+)=IFCSHAPEREPRESENTATION\([^;]*'Body'[^;]*\);/)![1];
  const layeredSource = source.replace('\nENDSEC;\nEND-ISO-10303-21;', `\n#900001=IFCPRESENTATIONLAYERASSIGNMENT('Layer',$,(#${bodyRep}),$);\nENDSEC;\nEND-ISO-10303-21;`);
  const layeredBim = await loadInlineModel(layeredSource);
  expect(() => layeredBim.store.mirrorElements('default', [wall.expressId], { axis: [[9, -10], [9, 10]] })).toThrow(/representation owners/);
  const subtypeSource = source.replace(/=IFCDOOR\(/g, '=IFCDOORSTANDARDCASE(');
  const subtypeBim = await loadInlineModel(subtypeSource);
  subtypeBim.store.mirrorElements('default', [wall.expressId], { axis: [[9, -10], [9, 10]] });
  expect(exportStep(subtypeBim)).toContain('.SINGLE_SWING_RIGHT.');
  const refs = bim.store.mirrorElements('default', [wall.expressId], { axis: [[9, -10], [9, 10]], copy: true });
  expect(refs).toHaveLength(1);
  const step = exportStep(bim);
  expect(step.match(/=IFCRELVOIDSELEMENT\(/g)).toHaveLength(2);
  expect(step.match(/=IFCRELFILLSELEMENT\(/g)).toHaveLength(2);
  expect(step).toContain('.SINGLE_SWING_RIGHT.');
  const [box] = await boxes(bim, [refs[0].expressId]);
  expect(box.min[0]).toBeCloseTo(5, 3);
  expect(box.max[0]).toBeCloseTo(8, 3);
  bim.store.mirrorElements('default', [refs[0].expressId], { axis: [[0, 0], [10, 0]] });
  const [again] = await boxes(bim, [refs[0].expressId]);
  expect(again.min[1]).toBeCloseTo(-1.1, 3);
  expect(again.max[1]).toBeCloseTo(-.9, 3);
  // #9409: unused type catalogue entries retain their handedness. Assert the
  // saved doors after two reflections, rather than every enum in the file.
  const saved = await loadInlineModel(exportStep(bim), 'mirror-save');
  const doors = saved.query().byType('IfcDoor').toArray();
  expect(doors).toHaveLength(2);
  for (const door of doors) {
    const operation = saved.attributes(door.ref).find(attribute => attribute.name === 'OperationType')?.value;
    expect(String(operation).replace(/^\.|\.$/g, '')).toBe('SINGLE_SWING_LEFT');
  }
  const shared = bim.store.addWall('default', level, { Start: [10, 7, 0], End: [13, 7, 0], Thickness: .3, Height: 3 });
  const placement = bim.attributes(wall).find(a => a.name === 'ObjectPlacement')!.value;
  bim.store.setPositionalAttribute(shared, 5, placement);
  expect(() => bim.store.mirrorElements('default', [wall.expressId, shared.expressId], { axis: [[0, -1], [0, 1]] })).toThrow(/shares a local placement/);
  const first = bim.store.addWall('default', level, { Start: [0, 10, 0], End: [4, 10, 0], Thickness: .2, Height: 3 });
  bim.store.addWall('default', level, { Start: [4, 10, 0], End: [4, 13, 0], Thickness: .2, Height: 3 });
  expect(() => bim.store.mirrorElements('default', [first.expressId], { axis: [[10, -1], [10, 1]] })).toThrow(/both sides of a wall join/);
});
it('#9296 C5 reuses the classification system and exports the assigned reference', async () => {
  const { bim, level } = await setup();
  const wall = bim.store.addWall('default', level, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3 });
  bim.store.addClassification('default', { System: 'Uniclass 2015', Identification: 'EF_25_10', Name: 'Walls', objects: [wall.expressId] });
  bim.store.addClassification('default', { System: 'Uniclass 2015', Identification: 'EF_25_20', Name: 'Floors', objects: [wall.expressId] });
  const step = exportStep(bim);
  expect(step.match(/=IFCCLASSIFICATION\(/g)).toHaveLength(1);
  expect(step.match(/=IFCCLASSIFICATIONREFERENCE\(/g)).toHaveLength(2);
  expect(step.match(/=IFCRELASSOCIATESCLASSIFICATION\(/g)).toHaveLength(2);
});
