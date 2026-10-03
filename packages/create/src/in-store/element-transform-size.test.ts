/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: persisted Bonsai source plus authored overlay, not a mock placement writer. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter, expandAffectedSet } from '@ifc-lite/export';
import { addWallToStore } from './wall.js';
import { addBeamToStore } from './beam.js';
import { addSlabToStore } from './slab.js';
import { addOpeningToStore } from './opening.js';
import { resolveSpatialAnchor, AnchorEntityReader } from './resolve-anchor.js';
import { resolveHostAnchor, placedBodyExtent } from './resolve-host.js';
import { readElementSizeInStore, setElementSizeInStore } from './element-size-edit.js';
import { resizeWallInStore, readWallMetres } from './wall-size-edit.js';
import { transformElementsInStore } from './element-transform-edit.js';
import { planElementTransform } from './element-transform-plan.js';
import { asExpressIdRef, resolvePlacementChain } from './edit/placement-core.js';

function refOf(value: unknown): string {
  const id = asExpressIdRef(value);
  if (id === null) throw new Error('The fixture reference must resolve');
  return `#${id}`;
}

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
async function setup(millimetres = false) {
  let text = readFileSync(SAMPLE, 'utf8');
  // Metamorphic unit variant: new elements authored in metres must write native millimetres.
  if (millimetres) text = text.replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(dataStore, view);
  return { dataStore, view, editor, anchor: resolveSpatialAnchor(dataStore, 42, view) };
}
async function persist(target: Awaited<ReturnType<typeof setup>>) {
  const bytes = new StepExporter(target.dataStore, target.view).export({ schema: 'IFC4', applyMutations: true }).content;
  const dataStore = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(dataStore, view);
  return { dataStore, view, editor };
}
function size(target: Parameters<typeof setElementSizeInStore>[0], id: number, patch: Parameters<typeof setElementSizeInStore>[2]) {
  return target.editor.runAtomic(draft => {
    const result = setElementSizeInStore({ ...target, editor: draft, view: draft.getMutationView() }, id, patch);
    if (!result.ok) throw new Error(result.reason);
    return result;
  });
}

describe.each([false, true])('#6232 transform/size IFC4 native millimetres=%s', millimetres => {
  it('keeps persisted linear identity, far endpoint and unrelated source records while resizing', async () => {
    const initial = await setup(millimetres);
    const beam = addBeamToStore(initial.editor, initial.anchor, { Start: [1, 2, 3], End: [5, 2, 3], Width: .2, Height: .3 }).beamId;
    const target = await persist(initial), before = new AnchorEntityReader(target.dataStore, target.view).entity(beam)!;
    const peer = new AnchorEntityReader(target.dataStore, target.view).entity(1222)!;
    size(target, beam, { kind: 'linear', length: 5, fixed: 'end', width: .25, cross: .4 });
    expect(readElementSizeInStore(target, beam)).toEqual({ kind: 'linear', length: 5, width: .25, cross: .4, profiled: false });
    const scale = millimetres ? .001 : 1;
    expect(resolvePlacementChain(target.dataStore, target.view, target.editor, beam)?.coordinates.map(v => v * scale)).toEqual([0, 2, 3]);
    expect(new AnchorEntityReader(target.dataStore, target.view).entity(beam)?.attributes[0]).toEqual(before.attributes[0]);
    expect(new AnchorEntityReader(target.dataStore, target.view).entity(1222)).toEqual(peer);
  });

  it('carries a hosted cut once, then rotates about a storey pivot and preserves relationships', async () => {
    const target = await setup(millimetres);
    const wall = addWallToStore(target.editor, target.anchor, { Start: [0, 8, 0], End: [5, 8, 0], Thickness: .2, Height: 3 }).wallId;
    const opening = addOpeningToStore(target.editor, resolveHostAnchor(target.dataStore, wall, target.view), { Offset: 2, Width: 1, Height: 1.2, Sill: .8 }).openingId;
    const plan = planElementTransform({ ...target, selected: [wall, opening], storeyOf: () => 42 });
    expect(plan.roots.map(root => root.expressId)).toEqual([wall]);
    expect(plan.carried).toContain(opening);
    const openingPoint = resolvePlacementChain(target.dataStore, target.view, target.editor, opening)!.coordinates;
    target.editor.runAtomic(draft => transformElementsInStore({ ...target, editor: draft, view: draft.getMutationView(), selected: [wall, opening], op: { kind: 'move', delta: [2, 1] } }));
    expect(readWallMetres(target, wall)?.start).toEqual([2, 9, 0]);
    expect(resolvePlacementChain(target.dataStore, target.view, target.editor, opening)?.coordinates).toEqual(openingPoint);
    expect(expandAffectedSet(target.dataStore, target.view, [wall], 'hostsChanged')).toContain(opening);
    target.editor.runAtomic(draft => transformElementsInStore({ ...target, editor: draft, view: draft.getMutationView(), selected: [wall], op: { kind: 'rotate', pivot: [2, 9], angle: Math.PI / 2 } }));
    const moved = readWallMetres(target, wall)!;
    expect(moved.end[0]).toBeCloseTo(2); expect(moved.end[1]).toBeCloseTo(14);
    expect(resolveHostAnchor(target.dataStore, wall, target.view).hostKind).toBe('wall');
  });

  it('refits wall/slab void depths and rolls back late combined-size refusal', async () => {
    const target = await setup(millimetres);
    const wall = addWallToStore(target.editor, target.anchor, { Start: [0, 6, 0], End: [5, 6, 0], Thickness: .2, Height: 3 }).wallId;
    const cut = addOpeningToStore(target.editor, resolveHostAnchor(target.dataStore, wall, target.view), { Offset: 2, Width: 1, Height: 2 }).openingId;
    size(target, wall, { kind: 'wall', thickness: .6 });
    const body = resolveHostAnchor(target.dataStore, wall, target.view).hostBounds!, voidBody = placedBodyExtent(target.dataStore, cut, target.view)!;
    expect(voidBody.min[1]).toBeLessThan(body.min[1]); expect(voidBody.max[1]).toBeGreaterThan(body.max[1]);
    const slab = addSlabToStore(target.editor, target.anchor, { Position: [0, 0, 0], Width: 4, Depth: 4, Thickness: .2 }).slabId;
    const slabCut = addOpeningToStore(target.editor, resolveHostAnchor(target.dataStore, slab, target.view), { Position: [1, 1], Width: .5, Depth: .5 }).openingId;
    expect(size(target, slab, { kind: 'slab', thickness: .5 }).remesh).toContain(slabCut);
    const before = structuredClone({ records: target.view.getNewEntities(), journal: target.view.getMutations() }), allocator = target.view.peekNextExpressId();
    expect(() => size(target, wall, { kind: 'wall', thickness: .8, height: 1 })).toThrow(/above the new top/);
    expect({ records: target.view.getNewEntities(), journal: target.view.getMutations() }).toEqual(before);
    expect(target.view.peekNextExpressId()).toBe(allocator);
  });

  it('rejects non-finite endpoints and tilted rotation before leaking a partial multi-selection move', async () => {
    const target = await setup(millimetres);
    const wall = addWallToStore(target.editor, target.anchor, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: .2, Height: 3 }).wallId;
    expect(resizeWallInStore(target, wall, [0, 0, 0], [Number.NaN, 0, 0])).toMatchObject({ ok: false });
    const beam = addBeamToStore(target.editor, target.anchor, { Start: [0, 0, 0], End: [5, 0, 2], Width: .2, Height: .3 }).beamId;
    const before = structuredClone(target.view.getMutations());
    expect(() => target.editor.runAtomic(draft => transformElementsInStore({ ...target, editor: draft, view: draft.getMutationView(), selected: [wall, beam], op: { kind: 'rotate', pivot: [1, 1], angle: .2 } }))).toThrow(/tilted/);
    expect(target.view.getMutations()).toEqual(before);
  });
});

it('#6232 refuses persisted shared placement/profile leaves without moving or resizing another occurrence', async () => {
  const initial = await setup();
  const first = addBeamToStore(initial.editor, initial.anchor, { Start: [1, 2, 3], End: [5, 2, 3], Width: .2, Height: .3 }).beamId;
  const second = addBeamToStore(initial.editor, initial.anchor, { Start: [7, 2, 3], End: [11, 2, 3], Width: .2, Height: .3 }).beamId;
  const reader = new AnchorEntityReader(initial.dataStore, initial.view), firstRow = reader.entity(first)!;
  initial.editor.setPositionalAttribute(second, 5, refOf(firstRow.attributes[5]));
  initial.editor.setPositionalAttribute(second, 6, refOf(firstRow.attributes[6]));
  const target = await persist(initial);
  const before = structuredClone({ records: target.view.getNewEntities(), journal: target.view.getMutations() }), allocator = target.view.peekNextExpressId();
  expect(() => size(target, first, { kind: 'linear', width: .4 })).toThrow(/shares placement or geometry/);
  expect(() => target.editor.runAtomic(draft => transformElementsInStore({ ...target, editor: draft, view: draft.getMutationView(), selected: [first], op: { kind: 'move', delta: [1, 0] } }))).toThrow(/shares placement or geometry/);
  expect({ records: target.view.getNewEntities(), journal: target.view.getMutations() }).toEqual(before);
  expect(target.view.peekNextExpressId()).toBe(allocator);
  // Retargeting the alias away from the first occurrence removes the refusal.
  const separate = addBeamToStore(target.editor, resolveSpatialAnchor(target.dataStore, 42, target.view), { Start: [7, 2, 3], End: [11, 2, 3], Width: .2, Height: .3 }).beamId;
  const separateRow = new AnchorEntityReader(target.dataStore, target.view).entity(separate)!;
  target.editor.setPositionalAttribute(second, 5, refOf(separateRow.attributes[5]));
  target.editor.setPositionalAttribute(second, 6, refOf(separateRow.attributes[6]));
  expect(size(target, first, { kind: 'linear', width: .4 }).ok).toBe(true);
});

it.each([false,true])('#6232 millimetre beam size conversion overflow preserves full graph/journal/allocator, persisted=%s', async persisted => {
  const initial=await setup(true);
  const beam=addBeamToStore(initial.editor,initial.anchor,{Start:[1,2,3],End:[5,2,3],Width:.2,Height:.3}).beamId;
  const target=persisted?await persist(initial):initial;
  const snapshot=()=>({
    graph:Array.from(new StepExporter(target.dataStore,target.view).export({schema:'IFC4',applyMutations:true,timeStamp:'2026-10-03T00:00:00'}).content),
    records:structuredClone(target.view.getNewEntities()), journal:structuredClone(target.view.getMutations()), next:target.view.peekNextExpressId(),
  });
  const before=snapshot();
  expect(()=>size(target,beam,{kind:'linear',length:1e308})).toThrow(/finite|overflow/i);
  expect(snapshot()).toEqual(before);
});
