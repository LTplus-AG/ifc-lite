/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { trimExtendElementInStore } from './element-trim-extend.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { addHostedElementInStore } from './hosted-element.js';
import { readHostedFill } from './hosted-fill-read.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { readWallJoinTarget, readWallJoinRels } from './wall-join-read.js';
import { resolveLinearElementChain } from './edit/linear-element-edit.js';
import { resolvePlacementChain } from './edit/placement-core.js';
import { readAttributes } from './edit/placement-core.js';

async function session() {
  const bytes = new Uint8Array(await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url)));
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view), anchor = resolveSpatialAnchor(store, 42, view);
  const wall = addOrdinaryElementInStore(editor, anchor, { kind: 'wall', params: { Start: [0, 5, 0], End: [8, 5, 0], Height: 3, Thickness: .2 } });
  const boundary = addOrdinaryElementInStore(editor, anchor, { kind: 'wall', params: { Start: [10, 0, 0], End: [10, 10, 0], Height: 3, Thickness: .2 } });
  const snapshot = () => structuredClone({ entities: [...view.getNewEntities()].sort((a, b) => a.expressId - b.expressId), changes: view.getEffectiveChanges(), mutations: view.getMutations() });
  return { store, view, editor, anchor, wall, boundary, snapshot };
}

describe('#6232 D5 shared trim/extend', () => {
  it('extends and joins in the live storey, retains root identity and completely Undoes only this edit', async () => {
    const s = await session(), before = s.snapshot();
    const guid = readAttributes(s.store, s.view, s.editor, s.wall)?.[0];
    const result = recordCompoundMutation(s.view, view => trimExtendElementInStore(s.store, new StoreEditor(s.store, view), s.wall,
      { mode: 'extend', click: [8, 5], boundary: { wallId: s.boundary } }));
    expect(result.joined).toBe(true);
    expect(result.walls).toEqual([s.wall, s.boundary]);
    expect(readWallJoinRels(s.store, s.view, new Set([s.wall]))).toHaveLength(1);
    expect(readAttributes(s.store, s.view, s.editor, s.wall)?.[0]).toBe(guid);
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('Trim must record one compound'); });
    expect(s.snapshot()).toEqual(before);
  });

  it('a moved start reanchors a hosted filling, and refuses a cut through it without consuming IDs', async () => {
    const s = await session();
    const hosted = addHostedElementInStore(s.store, s.editor, s.wall, { kind: 'door', params: { Offset: 4, Sill: 0, Width: 1, Height: 2 } });
    const read = readHostedFill(s.store, hosted.expressId, s.view)!;
    trimExtendElementInStore(s.store, s.editor, s.wall, { mode: 'trim', click: [0, 5], boundary: { a: [2, 0], b: [2, 10], tMin: 0, tMax: 1, reach: 0 } });
    const after = readHostedFill(s.store, hosted.expressId, s.view)!;
    expect(after.location[0]).toBeCloseTo(read.location[0] - 2);
    expect(readWallJoinTarget(s.store, s.view, s.wall, 1)?.wall.start).toEqual([2, 5]);
    const before = s.snapshot(), next = s.view.peekNextExpressId();
    expect(() => trimExtendElementInStore(s.store, s.editor, s.wall, { mode: 'trim', click: [2, 5], boundary: { a: [4.5, 0], b: [4.5, 10], tMin: 0, tMax: 1, reach: 0 } })).toThrow('hosted');
    expect(s.snapshot()).toEqual(before);
    expect(s.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId).toBe(next);
  });

  it('refuses an ambiguous or deleted boundary without mutation', async () => {
    const s = await session();
    s.editor.removeEntity(s.boundary);
    const before = s.snapshot();
    expect(() => trimExtendElementInStore(s.store, s.editor, s.wall, { mode: 'extend', click: [8, 5], boundary: { wallId: s.boundary } })).toThrow(/^Boundary wall /);
    expect(s.snapshot()).toEqual(before);
  });
});

it('#6232 end-only beam reach leaves a shared start point and peer untouched, while start reach refuses atomically', async () => {
  const s = await session();
  const beam = (y: number) => addOrdinaryElementInStore(s.editor, s.anchor, { kind: 'beam', params: { Start: [0, y, 0], End: [8, y, 0], Width: .2, Height: .3 } });
  const id = beam(20), peer = beam(25);
  const chain = resolveLinearElementChain(s.store, s.view, s.editor, id, 1)!;
  const peerPlacement = resolvePlacementChain(s.store, s.view, s.editor, peer)!;
  s.editor.setPositionalAttribute(peerPlacement.axisPlacementId, 0, `#${chain.startPointId}`);
  const peerBefore = resolveLinearElementChain(s.store, s.view, s.editor, peer, 1);
  const result = trimExtendElementInStore(s.store, s.editor, id, { mode: 'extend', click: [8, 20], boundary: { a: [10, 18], b: [10, 22], tMin: 0, tMax: 1, reach: 0 } });
  expect(result.end).toBe('end');
  expect(result.length).toBeCloseTo(10);
  expect(resolveLinearElementChain(s.store, s.view, s.editor, peer, 1)).toEqual(peerBefore);
  const before = s.snapshot(), next = s.view.peekNextExpressId();
  expect(() => trimExtendElementInStore(s.store, s.editor, id, { mode: 'extend', click: [0, 20], boundary: { a: [-2, 18], b: [-2, 22], tMin: 0, tMax: 1, reach: 0 } })).toThrow(/shares placement or geometry/);
  expect(s.snapshot()).toEqual(before);
  expect(s.view.peekNextExpressId()).toBe(next);
});
