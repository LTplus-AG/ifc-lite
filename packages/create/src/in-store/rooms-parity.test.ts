/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { IfcCreator } from '../index.js';
import { parseModel } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { generateSpacesFromWalls } from './generate-spaces.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { roomChainInStore } from './room-store.js';
import { polygonArea } from './room-footprint-offset.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';

async function setup() {
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const corners = [[0, 0], [10, 0], [10, 6], [0, 6]] as const;
  const walls = corners.map((p, i) => addWallToStore(editor, anchor, { Start: [...p, 0], End: [...corners[(i + 1) % 4], 0], Thickness: .2, Height: 3 }).wallId);
  const partition = addWallToStore(editor, anchor, { Start: [5, 0, 0], End: [5, 6, 0], Thickness: .1, Height: 3 }).wallId;
  for (let i = 0; i < 4; i++) joinWallsInStore(editor, store, resolveWallJoinAnchor(store, view), walls[i], walls[(i + 1) % 4]);
  const generated = generateSpacesFromWalls(editor, store, storey, {}, view);
  const areas = () => generated.emitted.map(({ result }) => {
    const chain = roomChainInStore(store, editor, result.spaceId);
    if (!chain.ok) throw new Error(chain.reason);
    return polygonArea(chain.chain.footprint);
  }).sort((a, b) => a - b);
  return { store, view, editor, partition, generated, areas };
}
describe('rooms inside wall faces (#9296)', () => {
  it('insets joined session walls and stores net and gross areas', async () => {
    const s = await setup();
    expect(s.areas()).toEqual([expect.closeTo(28.13, 5), expect.closeTo(28.13, 5)]);
    for (const { result } of s.generated.emitted) {
      const q = s.view.getQuantitiesForEntity(result.spaceId).find(q => q.name === 'Qto_SpaceBaseQuantities');
      expect(q?.quantities.find(q => q.name === 'NetFloorArea')?.value).toBeCloseTo(28.13);
      expect(q?.quantities.find(q => q.name === 'GrossFloorArea')?.value).toBeCloseTo(30);
    }
  });
  it('moves a boundary and both rooms in one compound edit', async () => {
    const s = await setup();
    const before = s.view.getMutations().length;
    recordCompoundMutation(s.view, view => {
      const editor = new StoreEditor(s.store, view);
      transformElementsInStore({ dataStore: s.store, view, editor, selected: [s.partition], op: { kind: 'move', delta: [1, 0] } });
    });
    expect(s.areas()).toEqual([expect.closeTo(22.33, 5), expect.closeTo(33.93, 5)]);
    expect(s.view.getMutations().length).toBeGreaterThan(before);
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('Expected compound inverse'); });
    expect(s.areas()).toEqual([expect.closeTo(28.13, 5), expect.closeTo(28.13, 5)]);
    expect(s.view.getMutations().length).toBe(before);
  });
});
