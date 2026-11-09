/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { newStorey } from './wall-join-mesh.oracle.js';
import { addOrdinaryElementInStore, type OrdinaryInStoreElement } from './ordinary-element.js';
import * as reads from './wall-join-read.js';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';
import { withWallAutojoinIndex } from './wall-autojoin-index.js';

afterEach(() => vi.restoreAllMocks());

for (const recorded of [false, true]) for (const count of [16, 64]) it(`#9296 / #9406 unrelated wall ${count + 1} reads only its own join target (recorded=${recorded})`, async () => {
  const s = await newStorey();
  const add = (x: number) => {
    const element: OrdinaryInStoreElement = { kind: 'wall', params: {
    Start: [x, 0, 0], End: [x + 4, 0, 0], Height: 3, Thickness: .2,
    } };
    return recorded ? withWallAutojoinIndex(s.store, s.view, wallIndex => recordCompoundMutation(s.view, draft =>
      addOrdinaryElementInStore(new StoreEditor(s.store, draft), s.anchor, element, { store: s.store, wallIndex })))
      : addOrdinaryElementInStore(s.editor, s.anchor, element, { store: s.store });
  };
  for (let i = 0; i < count; i++) add(i * 10);
  const read = vi.spyOn(reads, 'readWallJoinTarget');
  const seed = vi.spyOn(reads, 'readWallJoinEndpoints');
  const wall = add(count * 10);
  expect(read.mock.calls.map(call => call[2])).toEqual([wall]);
  expect(seed).not.toHaveBeenCalled();
  expect(reads.readWallJoinRels(s.store, s.view)).toEqual([]);
});

it('#9296 indexes both sides of rounded endpoint/elevation boundaries', async () => {
  const s = await newStorey();
  const add = (Start: [number, number, number], End: [number, number, number]) => addOrdinaryElementInStore(s.editor, s.anchor,
    { kind: 'wall', params: { Start, End, Height: 3, Thickness: .2 } }, { store: s.store });
  add([-4, 0, .49e-6], [.49e-6, 0, .49e-6]);
  add([.51e-6, 0, .51e-6], [.51e-6, 4, .51e-6]);
  expect(reads.readWallJoinRels(s.store, s.view)).toHaveLength(1);
  add([.51e-6, 4, 3], [4, 4, 3]);
  expect(reads.readWallJoinRels(s.store, s.view)).toHaveLength(1);
});

it('#9296 refreshes endpoints after a skip-history placement edit', async () => {
  const s = await newStorey();
  const a = addOrdinaryElementInStore(s.editor, s.anchor, { kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: .2 } }, { store: s.store });
  const before = reads.readWallJoinTarget(s.store, s.view, a, 1)!;
  s.view.setPositionalAttribute(before.locationPointId, 0, [10, 0, 0], true);
  addOrdinaryElementInStore(s.editor, s.anchor, { kind: 'wall', params: { Start: [14, 0, 0], End: [14, 3, 0], Height: 3, Thickness: .2 } }, { store: s.store });
  expect(reads.readWallJoinRels(s.store, s.view)).toHaveLength(1);
});

it('#9296 discarded outer drafts do not leave ghost endpoint candidates', async () => {
  const s = await newStorey();
  const element = { kind: 'wall' as const, params: { Start: [0, 0, 0] as [number, number, number], End: [4, 0, 0] as [number, number, number], Height: 3, Thickness: .2 } };
  expect(() => withWallAutojoinIndex(s.store, s.view, wallIndex => s.editor.runAtomic(draft => {
    addOrdinaryElementInStore(draft, s.anchor, element, { store: s.store, wallIndex });
    throw new Error('late publication refusal');
  }))).toThrow('late publication refusal');
  expect(s.view.getNewEntities()).toEqual([]);
  const read = vi.spyOn(reads, 'readWallJoinTarget');
  const wall = addOrdinaryElementInStore(s.editor, s.anchor, element, { store: s.store });
  expect(read.mock.calls.map(call => call[2])).toEqual([wall]);
});

it('#9296 excludes a forgotten wall from subsequent endpoint candidates', async () => {
  const s = await newStorey();
  const element = { kind: 'wall' as const, params: { Start: [0, 0, 0] as [number, number, number], End: [4, 0, 0] as [number, number, number], Height: 3, Thickness: .2 } };
  const a = addOrdinaryElementInStore(s.editor, s.anchor, element, { store: s.store });
  s.editor.removeEntity(a);
  const read = vi.spyOn(reads, 'readWallJoinTarget');
  const b = addOrdinaryElementInStore(s.editor, s.anchor, element, { store: s.store });
  expect(read.mock.calls.map(call => call[2])).toEqual([b]);
});
