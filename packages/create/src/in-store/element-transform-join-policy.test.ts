/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { addWallToStore } from './wall.js';
import { joinWallsInStore } from './wall-join-edit.js';
import { readWallJoinRels, readWallJoinTarget } from './wall-join-read.js';
import { newStorey, bodyQuad } from './wall-join-mesh.oracle.js';
import { transformElementsInStore, type StoreyTransformOp } from './element-transform-edit.js';
import type { PlanPoint } from './wall-join.js';

async function joined(path: boolean, reverse = false, parallel = false) {
  const s = await newStorey();
  const wall = (a: PlanPoint, b: PlanPoint) => addWallToStore(s.editor, s.anchor, {
    Start: [...a, 0], End: [...b, 0], Thickness: .2, Height: 3, Axis: true,
  }).wallId;
  const a = wall([0, 10], [path ? 8 : 4, 10]);
  const ends: [PlanPoint, PlanPoint] = parallel ? [[4, 10], [8, 10]] : [[4, 6], [4, 10]];
  const b = reverse ? wall(ends[1], ends[0]) : wall(...ends);
  joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b);
  const move = (op: StoreyTransformOp) => s.editor.runAtomic(editor => transformElementsInStore({
    editor, dataStore: s.store, view: editor.getMutationView(), selected: [a], op,
  }));
  return { ...s, a, b, move };
}

for (const reverse of [false, true]) it(`#9296 T end follows the moved face on its own axis; reverse=${reverse}`, async () => {
  const s = await joined(true, reverse);
  s.move({ kind: 'move', delta: [1, 1] });
  const b = readWallJoinTarget(s.store, s.view, s.b, 1)!.wall;
  expect(b.start).toEqual(reverse ? [4, 11] : [4, 6]);
  expect(b.end).toEqual(reverse ? [4, 6] : [4, 11]);
  // The body stops at the moved path wall's near face (not its centreline).
  expect(Math.max(...bodyQuad(b).map(p => p[1]))).toBeCloseTo(10.9, 8);
});

for (const reason of ['parallel', 'collapse', 'reverse'] as const) it(`#9296 ${reason} intersection refuses atomically with an actionable reason`, async () => {
  const s = await joined(false, false, reason === 'parallel');
  const before = structuredClone({ records: s.view.getNewEntities(), journal: s.view.getMutations(), next: s.view.peekNextExpressId() });
  expect(() => s.move({ kind: 'move', delta: [0, reason === 'parallel' ? 1 : reason === 'collapse' ? -4 : -5] }))
    .toThrow(/Cannot carry wall join.*(parallel|collapse|reverse)/);
  expect({ records: s.view.getNewEntities(), journal: s.view.getMutations(), next: s.view.peekNextExpressId() }).toEqual(before);
});

// #9406 changes sliding walls; preserve the existing corner carry for rotation.
it('#9406 rotating a joined wall still carries the corner through the turn', async () => {
  const s = await joined(false);
  s.move({ kind: 'rotate', pivot: [0, 10], angle: Math.PI / 2 });
  const b = readWallJoinTarget(s.store, s.view, s.b, 1)!.wall;
  expect(b.start).toEqual([4, 6]);
  expect(b.end[0]).toBeCloseTo(0, 8);
  expect(b.end[1]).toBeCloseTo(14, 8);
});

it('#9406 moving a T-ending wall off its stationary through wall still detaches it', async () => {
  const s = await joined(true);
  s.editor.runAtomic(editor => transformElementsInStore({ editor, dataStore: s.store,
    view: editor.getMutationView(), selected: [s.b], op: { kind: 'move', delta: [0, -1] } }));
  expect(readWallJoinRels(s.store, s.view)).toEqual([]);
  expect(readWallJoinTarget(s.store, s.view, s.b, 1)!.wall.end).toEqual([4, 9]);
});
