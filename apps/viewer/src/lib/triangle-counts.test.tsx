/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { IfcParser } from '@ifc-lite/parser';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene';
import { cleanup, render } from '@/test/render';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF';
import { TriangleCountRow } from '@/components/viewer/properties/TriangleCountRow';
import { prepareListProviders } from './lists/prepare-providers';

const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#2=IFCWALL('Wall000000000000000001A',$,'Wall-A',$,$,$,$,$,$);
#3=IFCWALL('Wall000000000000000001B',$,'Wall-B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
const definition: ListDefinition = { id: 'triangles', name: 'Triangles', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [{ id: 'count', source: 'geometry', propertyName: 'TriangleCount' }],
  sortBy: { columnId: 'count', direction: 'desc' } };
function triangle(expressId: number, triangles = 1): MeshData {
  return { expressId, modelIndex: 0, positions: new Float32Array([0,0,0,1,0,0,0,1,0]),
    normals: new Float32Array([0,0,1,0,0,1,0,0,1]), indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i % 3), color: [1,1,1,1] };
}
const geometry: GeometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } } } };
afterEach(() => { cleanup(); clearGlobalRefs(); });

it('shows own model/object counts, live changes, and numeric list sorting across federation (#10370)', async () => {
  const bytes = new TextEncoder().encode(IFC);
  const storeA = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const storeB = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer, { disableWorkerScan: true });
  const a = fixtureModel('A'), b = fixtureModel('B', { idOffset: 1_000_000 });
  for (const [model, store] of [[a, storeA], [b, storeB]] as const) {
    model.ifcDataStore = store; model.geometryResult = geometry; model.loadState = 'complete'; model.maxExpressId = 3;
  }
  useViewerStore.setState({ ...fixtureModels(a, b), geometryResult: geometry });
  const { scene, device, pipeline } = appearanceInstanceScene([triangle(2), triangle(1_000_002)]);
  scene.appendToBatches([triangle(2), triangle(3, 12)], device, pipeline);
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  const ownModel = render(<TriangleCountRow modelId="A" />);
  const otherModel = render(<TriangleCountRow modelId="B" />);
  const ownObject = render(<TriangleCountRow modelId="A" globalId={2} />);
  const value = (ui: HTMLElement) => ui.querySelector('span[title]:not([title="Triangles"])')?.textContent;
  assert.equal(value(ownModel), '14');
  assert.equal(value(otherModel), '1', 'the other model has only one instanced triangle');
  assert.equal(value(ownObject), '2', 'flat and instanced pieces of one object are added');
  const providers = prepareListProviders(useViewerStore.getState(), {});
  const result = executeList(definition, providers.pairs.find(pair => pair.modelId === 'A')!.provider);
  assert.deepEqual(result.rows.map(row => [row.entityId, row.values[0]]), [[3, 12], [2, 2]], '12 sorts ahead of 2 numerically');
  assert.equal(result.columns[0].quantityType, undefined, 'counts do not acquire model length units');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'B')!.provider.getTriangleCount?.(2), 1);
  await act(async () => { scene.removeMeshesForEntity(2); await Promise.resolve(); });
  assert.equal(value(ownModel), '12');
  assert.equal(value(ownObject), '0');
  assert.equal(value(otherModel), '1');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'A')!.provider.getTriangleCount?.(2), 0, 'a prepared provider reads current topology');
});
