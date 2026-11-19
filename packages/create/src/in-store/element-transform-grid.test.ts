/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { newStorey } from './wall-join-mesh.oracle.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes } from './grid.js';
import { addColumnToStore } from './column.js';
import { addWallToStore } from './wall.js';
import { addHostedDoorToStore } from './hosted-fill.js';
import { resolveHostAnchor } from './resolve-host.js';
import { joinWallsInStore } from './wall-join-edit.js';
import { readWallJoinRels } from './wall-join-read.js';
import { planElementTransform } from './element-transform-plan.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { resolvePlacementChain } from './edit/placement-core.js';

async function setup() {
  const s = await newStorey();
  const grid = addGridToStore(s.editor, s.anchor, { Position: [0, 0, 0],
    ...rectangularGridAxes({ UOffsets: [0, 5], VOffsets: [0, 5] }),
  });
  const binding = gridIntersectionPlacement(s.editor, s.anchor, {
    Axes: [grid.uAxisIds[0], grid.vAxisIds[0]], GridPlacementId: grid.placementId,
  }, s.store);
  const target = { dataStore: s.store, view: s.view, editor: s.editor };
  return { ...s, grid, binding, target,
    plan: () => planElementTransform({ ...target, selected: [grid.gridId], storeyOf: () => s.storeyId }),
    move: (selected: readonly number[] = [grid.gridId]) => transformElementsInStore({ ...target, selected, op: { kind: 'move', delta: [1, 0] } }),
  };
}

it('#9406 directly grid-placed products are carried and returned for remesh without a second placement write', async () => {
  const s = await setup();
  const column = addColumnToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: .3, Depth: .3, Height: 3 });
  s.editor.setPositionalAttribute(column.columnId, 5, `#${s.binding.placementId}`);
  const placement = structuredClone(s.view.getNewEntity(s.binding.placementId));
  expect(s.plan().carried).toContain(column.columnId);
  expect(s.plan().refused).toEqual([]);
  const result = s.move();
  expect(result.remesh).toEqual(expect.arrayContaining([s.grid.gridId, column.columnId]));
  expect(s.view.getNewEntity(s.binding.placementId)).toEqual(placement);
  expect(resolvePlacementChain(s.store, s.view, s.editor, s.grid.gridId)?.coordinates).toEqual([1, 0, 0]);
});

it('#9406 a grid-carried wall also moves its independently storey-placed opening and filling', async () => {
  const s = await setup();
  const wall = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3 });
  const door = addHostedDoorToStore(s.editor, resolveHostAnchor(s.store, wall.wallId, s.view), { Offset: 2, Width: .9, Height: 2.1 });
  for (const placement of [door.opening.placementId, door.placementId]) {
    s.editor.setPositionalAttribute(placement, 0, `#${s.anchor.storeyPlacementId}`);
  }
  s.editor.setPositionalAttribute(wall.placementId, 0, `#${s.binding.placementId}`);
  const roots = s.plan().roots.map(root => root.expressId);
  expect(roots).toEqual(expect.arrayContaining([s.grid.gridId, door.opening.openingId, door.fillingId]));
  const before = [door.opening.openingId, door.fillingId].map(id => resolvePlacementChain(s.store, s.view, s.editor, id)!.coordinates);
  const result = s.move();
  for (const [i, id] of [door.opening.openingId, door.fillingId].entries()) {
    expect(resolvePlacementChain(s.store, s.view, s.editor, id)?.coordinates).toEqual([before[i][0] + 1, before[i][1], before[i][2]]);
  }
  expect(result.remesh).toEqual(expect.arrayContaining([s.grid.gridId, wall.wallId, door.opening.openingId, door.fillingId]));
});

for (const bothBound of [false, true]) it(`#9406 grid-carried wall joins ${bothBound ? 'stay rigid when both walls move' : 'refuse atomically when the neighbour stays'}`, async () => {
  const s = await setup();
  const a = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3 });
  const b = addWallToStore(s.editor, s.anchor, { Start: [4, 0, 0], End: [4, 3, 0], Thickness: .2, Height: 3 });
  joinWallsInStore(s.editor, s.store, s.joinAnchor, a.wallId, b.wallId);
  s.editor.setPositionalAttribute(a.placementId, 0, `#${s.binding.placementId}`);
  if (bothBound) s.editor.setPositionalAttribute(b.placementId, 0, `#${s.binding.placementId}`);
  const snapshot = () => structuredClone({ records: s.view.getNewEntities(), journal: s.view.getMutations(), next: s.view.peekNextExpressId() });
  const before = snapshot();
  if (!bothBound) {
    expect(s.move).toThrow(/carried.*joined.*stationary/i);
    expect(snapshot()).toEqual(before);
    expect(s.move([s.grid.gridId, b.wallId]).remesh).toEqual(expect.arrayContaining([s.grid.gridId, a.wallId, b.wallId]));
    expect(readWallJoinRels(s.store, s.view)).toHaveLength(1);
    expect(resolvePlacementChain(s.store, s.view, s.editor, b.wallId)?.coordinates).toEqual([5, 0, 0]);
  } else {
    expect(s.move().remesh).toEqual(expect.arrayContaining([s.grid.gridId, a.wallId, b.wallId]));
    expect(readWallJoinRels(s.store, s.view)).toHaveLength(1);
    expect(resolvePlacementChain(s.store, s.view, s.editor, s.grid.gridId)?.coordinates).toEqual([1, 0, 0]);
  }
});
