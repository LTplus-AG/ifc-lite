/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolvePlacementChain } from './edit/placement-core.js';
import { copyBatchInStore } from './copy-batch.js';
import { meshStairs as meshProducts, stairMeshBounds as bounds, stairWasmAvailable } from './__test__/stair-mesh.oracle.js';

async function fixture(axis: number[], persisted: boolean, leafTilt = false) {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  let store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const id = addOrdinaryElementInStore(editor, anchor, { kind: 'column', params: { Position: [10, 10, 1], Width: .2, Depth: .8, Height: 3 } });
  const chain = resolvePlacementChain(store, view, editor, id)!;
  const point = editor.addEntity('IfcCartesianPoint', [[2, 3, 0]]).expressId;
  const direction = editor.addEntity('IfcDirection', [axis]).expressId;
  const ref = editor.addEntity('IfcDirection', [[1, 0, 0]]).expressId;
  const frame = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, `#${direction}`, `#${ref}`]).expressId;
  const parent = editor.addEntity('IfcLocalPlacement', [`#${anchor.storeyPlacementId}`, `#${frame}`]).expressId;
  editor.setPositionalAttribute(chain.localPlacementId, 0, `#${parent}`);
  if (leafTilt) editor.setPositionalAttribute(chain.axisPlacementId, 1, `#${editor.addEntity('IfcDirection', [[1, 0, 1]]).expressId}`);
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00' }).content);
  if (persisted) {
    store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
    view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  }
  return { store, view, editor, id, text };
}

for (const persisted of [false, true]) for (const axis of [[0, 1, 1], [0, 0, -1]]) {
  it.skipIf(!stairWasmAvailable)(`#6232 public Copy refuses unsupported parent ${axis} persisted=${persisted} atomically`, async () => {
    const s = await fixture(axis, persisted);
    const beforeText = s.text(), beforeMesh = (await meshProducts(beforeText)).get(s.id)!;
    expect(beforeMesh.length).toBeGreaterThan(0);
    const records = structuredClone(s.editor.getNewEntities()), journal = structuredClone(s.view.getMutations()), next = s.view.peekNextExpressId();
    let error: unknown;
    try {
      const [copy] = copyBatchInStore(s.store, s.editor, [s.id], [{ offset: [0, 2, 0] }]);
      // A failing baseline records the actual native displacement, rather than
      // inferring geometry from a projected placement reader.
      const actual = bounds((await meshProducts(s.text())).get(copy.copyId)!);
      const before = bounds(beforeMesh);
      console.log('Unsupported parent accepted; native displacement:', actual.min.map((value, i) => value - before.min[i]));
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/parent.*upright/i);
    expect(s.text()).toBe(beforeText);
    expect(s.editor.getNewEntities()).toEqual(records);
    expect(s.view.getMutations()).toEqual(journal);
    expect(s.view.peekNextExpressId()).toBe(next);
  });
}
it.skipIf(!stairWasmAvailable)('#6232 upright parent retains legitimate tilted leaf native translation', async () => {
  const s = await fixture([0, 0, 2], true, true);
  const before = bounds((await meshProducts(s.text())).get(s.id)!);
  const [copy] = copyBatchInStore(s.store, s.editor, [s.id], [{ offset: [0, 2, 0] }]);
  const after = bounds((await meshProducts(s.text())).get(copy.copyId)!);
  for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++)
    expect(after[edge][i] - before[edge][i]).toBeCloseTo(i === 1 ? 2 : 0, 5);
});
