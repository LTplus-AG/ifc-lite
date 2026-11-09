/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it, vi } from 'vitest';
import { IfcCreator } from '../index.js';
import { StepExporter } from '@ifc-lite/export';
import { parseModel, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore } from './wall.js';
import { generateSpacesFromWalls } from './generate-spaces.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { roomChainInStore } from './room-store.js';
import { polygonArea } from './room-footprint-offset.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';

async function setup(custom = false, snapTolerance?: number) {
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storey, view);
  const corners = [[0, 0], [10, 0], [10, 6], [0, 6]] as const;
  const walls = corners.map((p, i) => addWallToStore(editor, anchor, { Start: [p[0] - (custom && i === 2 ? .26 : 0), p[1], 0], End: [...corners[(i + 1) % 4], 0], Thickness: .2, Height: 3 }).wallId);
  const partition = addWallToStore(editor, anchor, { Start: [5, 0, 0], End: [5, 6, 0], Thickness: .1, Height: 3 }).wallId;
  for (let i = 0; !custom && i < 4; i++) joinWallsInStore(editor, store, resolveWallJoinAnchor(store, view), walls[i], walls[(i + 1) % 4]);
  if (snapTolerance === 0) addWallToStore(editor, anchor, { Start: [5.05, 0, 0], End: [5.05, 6, 0], Thickness: .1, Height: 3 });
  const generated = generateSpacesFromWalls(editor, store, storey, custom ? { snapTolerance: .4 } : { snapTolerance }, view);
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
    const nets = s.generated.emitted.map(({ result }) => s.view.getQuantitiesForEntity(result.spaceId)
      .find(q => q.name === 'Qto_SpaceBaseQuantities')?.quantities.find(q => q.name === 'NetFloorArea')?.value).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(nets).toEqual([expect.closeTo(22.33, 5), expect.closeTo(33.93, 5)]);
    expect(s.view.getMutations().length).toBeGreaterThan(before);
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('Expected compound inverse'); });
    expect(s.areas()).toEqual([expect.closeTo(28.13, 5), expect.closeTo(28.13, 5)]);
    expect(s.view.getMutations().length).toBe(before);
  });
});

it.each([false, true])('retains custom snapping when a bounding wall moves, reopened=%s (#9423 review)', async reopened => {
  const s = await setup(true);
  expect(s.generated.emitted).toHaveLength(2);
  let store = s.store, view = s.view, editor = s.editor;
  if (reopened) {
    const content = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    store = (await parseModel(content, { disableWorkerScan: true })).store;
    view = new MutablePropertyView(null, 'm');
    view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
    editor = new StoreEditor(store, view);
  }
  const areas = () => s.generated.emitted.map(({ result }) => {
    const target = roomChainInStore(store, editor, result.spaceId);
    if (!target.ok) throw new Error(target.reason);
    return polygonArea(target.chain.footprint);
  });
  const before = areas();
  transformElementsInStore({ dataStore: store, view, editor, selected: [s.partition], op: { kind: 'move', delta: [1, 0] } });
  expect(before.every(a => areas().every(b => Math.abs(a - b) > 4))).toBe(true);
});
it('reports rooms that cannot be re-detected instead of silently skipping (#9423 review)', async () => {
  const s = await setup(true);
  // A legacy generated room has no retained detection options.
  for (const { result } of s.generated.emitted) s.view.deleteProperty(result.spaceId, 'IfcLite_SpaceGeneration', 'SnapTolerance');
  const notice = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    transformElementsInStore({ dataStore: s.store, view: s.view, editor: s.editor, selected: [s.partition], op: { kind: 'move', delta: [1, 0] } });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('cannot be re-detected'));
  } finally { notice.mockRestore(); }
});
it('pairs gross and net perimeters with their own areas before and after movement (#9423 review)', async () => {
  const s = await setup();
  const values = () => s.generated.emitted.map(({result}) => Object.fromEntries(s.view.getQuantitiesForEntity(result.spaceId).find(q => q.name === 'Qto_SpaceBaseQuantities')!.quantities.map(q => [q.name,q.value])));
  for (const q of values()) expect(q).toMatchObject({ GrossFloorArea: 30, NetFloorArea: expect.closeTo(28.13), GrossPerimeter: 22, NetPerimeter: expect.closeTo(21.3) });
  transformElementsInStore({ dataStore: s.store, view: s.view, editor: s.editor, selected: [s.partition], op: { kind: 'move', delta: [1, 0] } });
  expect(values().sort((a,b) => a.GrossFloorArea-b.GrossFloorArea)).toEqual([
    expect.objectContaining({ GrossFloorArea: 24, NetFloorArea: expect.closeTo(22.33), GrossPerimeter: 20, NetPerimeter: expect.closeTo(19.3) }),
    expect.objectContaining({ GrossFloorArea: 36, NetFloorArea: expect.closeTo(33.93), GrossPerimeter: 24, NetPerimeter: expect.closeTo(23.3) }),
  ]);
});

it('zero snap tolerance preserves exact room geometry on a no-op wall edit (#9423 round 2)', async () => {
  // Two nearby divider axes must remain distinct: the default .1 m tolerance
  // would merge them and alter the rooms' boundaries and quantities.
  const s = await setup(false, 0);
  expect(s.generated.emitted).toHaveLength(2);
  const before = s.areas();
  transformElementsInStore({ dataStore: s.store, view: s.view, editor: s.editor, selected: [s.partition], op: { kind: 'move', delta: [0, 0] } });
  expect(s.areas()).toEqual(before);
});
