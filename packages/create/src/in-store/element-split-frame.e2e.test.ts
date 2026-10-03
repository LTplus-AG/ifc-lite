/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor, AnchorEntityReader } from './resolve-anchor.js';
import { resolvePlacementChain } from './edit/placement-core.js';
import { placementInAncestor, applyFrame, type Frame3 } from './host-geometry-frame.js';
import { splitElementInStore, splitElementsInStore } from './element-split.js';
import { meshStairs as meshProducts, stairMeshBounds as meshBounds, stairWasmAvailable, type StairMesh } from './__test__/stair-mesh.oracle.js';
const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const width = .2, cross = .8, depth = 8, distance = 2;
function text(store: Parameters<typeof resolveSpatialAnchor>[0], view: MutablePropertyView) {
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
}
function volume(meshes: StairMesh[]) {
  let result = 0;
  for (const { positions: p, indices: t } of meshes)
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      result += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
  return Math.abs(result / 6);
}
function halfBounds(frame: Frame3) {
  const points: Frame3['o'][] = [];
  for (const x of [-width / 2, width / 2])
    for (const y of [-cross / 2, cross / 2])
      for (const z of [0, distance])
        points.push(applyFrame(frame, [x, y, z]));
  return { min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) };
}
function closeBounds(actual: ReturnType<typeof meshBounds>, expected: ReturnType<typeof meshBounds>) {
  for (const edge of ['min', 'max'] as const)
    for (let i = 0; i < 3; i++)
      expect(actual[edge][i]).toBeCloseTo(expected[edge][i], 5);
}
const cases = ([false, true] as const).flatMap(persisted =>
  (['rotated-column', 'tilted-column', 'rolled-beam', 'nested-beam'] as const).map(kind => ({ kind, persisted })));
it.skipIf(!stairWasmAvailable).each(cases)('#6232 split preserves native asymmetric-section half geometry for $kind persisted=$persisted (pnpm build:wasm)', async ({ kind, persisted }) => {
  const bytes = await readFile(sample);
  let store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const id = addOrdinaryElementInStore(editor, anchor, kind.endsWith('beam')
    ? { kind: 'beam', params: { Start: [10, 10, 1], End: [18, 10, 1], Width: width, Height: cross } }
    : { kind: 'column', params: { Position: [10, 10, 1], Width: width, Depth: cross, Height: depth, RefDirection: [1, 1, 0] } });
  const placement = resolvePlacementChain(store, view, editor, id)!;
  if (kind === 'tilted-column') {
    const axis = editor.addEntity('IfcDirection', [[1, 0, 1]]).expressId;
    editor.setPositionalAttribute(placement.axisPlacementId, 1, `#${axis}`);
  }
  if (kind === 'rolled-beam') {
    const ref = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
    editor.setPositionalAttribute(placement.axisPlacementId, 2, `#${ref}`);
  }
  if (kind === 'nested-beam') {
    const origin = editor.addEntity('IfcCartesianPoint', [[3, 4, 0]]).expressId;
    const direction = editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${origin}`, null, `#${direction}`]).expressId;
    const parent = editor.addEntity('IfcLocalPlacement', [`#${anchor.storeyPlacementId}`, `#${axis}`]).expressId;
    editor.setPositionalAttribute(placement.localPlacementId, 0, `#${parent}`);
  }
  // Persist the authored overlay into source: the command must preserve the
  // effective placement of imported occurrences, not only its own defaults.
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text(store, view)).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm');
    editor = new StoreEditor(store, view);
  }
  const sourceFrame = placementInAncestor(new AnchorEntityReader(store, view), resolvePlacementChain(store, view, editor, id)!.localPlacementId, null)!;
  const before = (await meshProducts(text(store, view))).get(id)!;
  expect(before.length).toBeGreaterThan(0);
  const result = splitElementInStore(store, editor, id, { kind: 'linear', distance });
  const after = await meshProducts(text(store, view));
  const kept = after.get(id)!, added = after.get(result.addedId)!;
  expect(added.length).toBeGreaterThan(0);
  closeBounds(meshBounds(added), halfBounds(sourceFrame));
  closeBounds(meshBounds([...kept, ...added]), meshBounds(before));
  expect(volume(kept) + volume(added)).toBeCloseTo(volume(before), 5);
  expect(result.leftId).toBe(result.addedId);
  expect(result.rightId).toBe(id);
});
it('#6232 malformed split basis refuses before emitting helpers and rolls back prior selected cuts', async () => {
  const bytes = await readFile(sample);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const first = addOrdinaryElementInStore(editor, anchor, { kind: 'column', params: { Position: [2, 2, 0], Width: width, Depth: cross, Height: depth } });
  const malformed = addOrdinaryElementInStore(editor, anchor, { kind: 'beam', params: { Start: [10, 10, 1], End: [18, 10, 1], Width: width, Height: cross } });
  const placement = resolvePlacementChain(store, view, editor, malformed)!;
  const parallel = editor.addEntity('IfcDirection', [[1, 0, 0]]).expressId;
  editor.setPositionalAttribute(placement.axisPlacementId, 2, `#${parallel}`);
  const snapshot = () => ({
    text: text(store, view), records: structuredClone(view.getNewEntities()),
    journal: structuredClone(view.getMutations()), next: view.peekNextExpressId(),
  });
  const before = snapshot();
  expect(() => splitElementsInStore(store, editor, [
    { expressId: first, cut: { kind: 'linear', distance } },
    { expressId: malformed, cut: { kind: 'linear', distance } },
  ])).toThrow('readable placement basis');
  expect(snapshot()).toEqual(before);
});
