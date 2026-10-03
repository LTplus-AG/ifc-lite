/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { copyBatchInStore } from './copy-batch.js';
import { createCopyContext } from './copy-product.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { meshStairs as meshProducts, stairMeshBounds as bounds, stairWasmAvailable } from './__test__/stair-mesh.oracle.js';

// This finite correctness stress control retains the 5000-level old-source
// RangeError oracle. It took ~23.5 s focused, but 192607 ms in the concurrent
// full CI suite (#6753); its deadline is not a performance threshold.
it.skipIf(!stairWasmAvailable)('#6232 public Copy traverses a real 5000-level acyclic imported assembly without call-stack recursion', async () => {
  const bytes = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  let store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 42, view);
  const point = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const frame = editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  const ids: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const placement = editor.addEntity('IfcLocalPlacement', [`#${anchor.storeyPlacementId}`, `#${frame}`]).expressId;
    ids.push(editor.addEntity('IfcElementAssembly', [generateIfcGuid(), null, `Assembly ${i}`, null, null, `#${placement}`, null, null, null, null]).expressId);
  }
  for (let i = 0; i < ids.length; i++) editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${ids[i]}`, [`#${ids[i + 1] ?? 1222}`]]);
  editor.addEntity('IfcRelContainedInSpatialStructure', [generateIfcGuid(), null, null, null, [`#${ids[0]}`], '#42']);
  const text = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
  store = await new IfcParser().parseColumnar(new TextEncoder().encode(text()).buffer, { disableWorkerScan: true });
  view = new MutablePropertyView(null, 'm'); editor = new StoreEditor(store, view);
  const before = bounds((await meshProducts(text())).get(1222)!);
  const [copy] = copyBatchInStore(store, editor, [ids[0]], [{ offset: [0, 3, 0] }]);
  expect(copy.partIds).toHaveLength(5000);
  expect(copy.openingIds).toHaveLength(2); expect(copy.fillingIds).toHaveLength(2);
  const wall = [...copy.copiedFrom].find(([, source]) => source === 1222)![0];
  const copied = createCopyContext(store, editor);
  expect(copied.read(wall)!.attributes[0]).not.toBe(copied.read(1222)!.attributes[0]);
  expect(new Set([...copy.copiedFrom.keys()].map(id => copied.read(id)!.attributes[0])).size).toBe(5005);
  expect(editor.getNewEntities().filter(entity => entity.type.toUpperCase() === 'IFCRELAGGREGATES')).toHaveLength(5000);
  let whole = copy.copyId;
  for (let i = 0; i < ids.length; i++) {
    const links = copied.parts.get(whole)!;
    expect(links).toHaveLength(1); expect(links[0].parts).toHaveLength(1);
    whole = links[0].parts[0];
    expect(copy.copiedFrom.get(whole)).toBe(ids[i + 1] ?? 1222);
  }
  expect(whole).toBe(wall);
  const meshes = await meshProducts(text());
  expect([...meshes.keys()].filter(id => copy.copiedFrom.has(id)).sort((a, b) => a - b)).toEqual([wall, ...copy.openingIds, ...copy.fillingIds].sort((a, b) => a - b));
  expect([...meshes.keys()].filter(id => copy.meshed.includes(id)).sort((a, b) => a - b)).toEqual([wall, ...copy.fillingIds].sort((a, b) => a - b));
  const after = bounds(meshes.get(wall)!);
  for (const edge of ['min', 'max'] as const) for (let i = 0; i < 3; i++)
    expect(after[edge][i] - before[edge][i]).toBeCloseTo(i === 1 ? 3 : 0, 4);
}, 300000);
