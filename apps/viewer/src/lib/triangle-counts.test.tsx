/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import { Scene } from '../../../../packages/renderer/src/scene.js';
import { IfcParser } from '@ifc-lite/parser';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import { useViewerStore, type FederatedModel } from '@/store';
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
afterEach(() => { cleanup(); clearGlobalRefs(); federationRegistry.clear(); });

it('keeps partial geometry unavailable in inspector and list output until explicit completion (#10370 review)', async () => {
  const bytes = new TextEncoder().encode(IFC);
  const model = fixtureModel('A', { idOffset: federationRegistry.registerModel('A', 3) });
  model.maxExpressId = 3;
  model.ifcDataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  model.geometryResult = { ...geometry, meshes: [triangle(2)], totalTriangles: 1, totalVertices: 3 };
  useViewerStore.setState({ ...fixtureModels(model), geometryResult: model.geometryResult });
  const scene = new Scene();
  scene.queueMeshes([triangle(2)]);
  scene.setTriangleCountReplayComplete(true); // The viewport supplied its full source; model flags can still be incomplete.
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  const modelRow = render(<TriangleCountRow modelId="A" />);
  const objectRow = render(<TriangleCountRow modelId="A" globalId={2} />);
  const value = (ui: HTMLElement) => ui.querySelector('span[title]:not([title="Triangles"])')?.textContent;
  const cases: Array<{ label: string; flags: Pick<FederatedModel, 'loadState' | 'geometryLoadState' | 'geometryRestorePending'>; count: number | null }> = [
    { label: 'geometry-only pending', flags: { geometryLoadState: 'pending' }, count: null },
    { label: 'geometry-only streaming', flags: { geometryLoadState: 'streaming' }, count: null },
    { label: 'interactive is still partial', flags: { geometryLoadState: 'interactive' }, count: null },
    { label: 'explicit geometry outranks old complete load', flags: { loadState: 'complete', geometryLoadState: 'streaming' }, count: null },
    { label: 'geometry failure is not a completed count', flags: { loadState: 'complete', geometryLoadState: 'error' }, count: null },
    { label: 'completed geometry can precede metadata', flags: { loadState: 'hydrating-metadata', geometryLoadState: 'complete' }, count: 1 },
    { label: 'explicit legacy load pending', flags: { loadState: 'streaming-geometry' }, count: null },
    { label: 'explicit legacy load complete', flags: { loadState: 'complete' }, count: 1 },
    { label: 'legacy geometry-only compatibility', flags: {}, count: 1 },
    { label: 'cache geometry not restored yet', flags: { geometryLoadState: 'complete', geometryRestorePending: true }, count: null },
  ];
  for (const entry of cases) {
    await act(async () => { useViewerStore.setState({ models: new Map([['A', {
      ...model, loadState: undefined, geometryLoadState: undefined, geometryRestorePending: false, ...entry.flags,
    }]]) }); });
    assert.equal(value(modelRow), entry.count === null ? '—' : '1', entry.label);
    assert.equal(value(objectRow), entry.count === null ? '—' : '1', entry.label);
    const provider = prepareListProviders(useViewerStore.getState(), {}).pairs[0].provider;
    assert.equal(provider.getTriangleCount?.(2), entry.count, entry.label);
  }
});

it('shows own model/object counts, live changes, and numeric list sorting across federation (#10370)', async () => {
  const bytes = new TextEncoder().encode(IFC);
  const storeA = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const storeB = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer, { disableWorkerScan: true });
  federationRegistry.clear();
  const a = fixtureModel('A', { idOffset: federationRegistry.registerModel('A', 3) });
  const b = fixtureModel('B', { idOffset: federationRegistry.registerModel('B', 3) });
  for (const [model, store] of [[a, storeA], [b, storeB]] as const) {
    model.ifcDataStore = store; model.geometryResult = geometry; model.loadState = 'complete'; model.maxExpressId = 3;
  }
  useViewerStore.setState({ ...fixtureModels(a, b), geometryResult: geometry });
  const { scene, device, pipeline } = appearanceInstanceScene([triangle(federationRegistry.toGlobalId('A', 2)), triangle(federationRegistry.toGlobalId('B', 2))]);
  scene.appendToBatches([triangle(2), triangle(3, 12), triangle(federationRegistry.toGlobalId('B', 3))], device, pipeline);
  scene.setTriangleCountReplayComplete(true);
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  const ownModel = render(<TriangleCountRow modelId="A" />);
  const otherModel = render(<TriangleCountRow modelId="B" />);
  const ownObject = render(<TriangleCountRow modelId="A" globalId={2} />);
  const otherObject = render(<TriangleCountRow modelId="B" globalId={federationRegistry.toGlobalId('B', 2)} />);
  const unreplayedObject = render(<TriangleCountRow modelId="B" globalId={federationRegistry.toGlobalId('B', 3)} />);
  const value = (ui: HTMLElement) => ui.querySelector('span[title]:not([title="Triangles"])')?.textContent;
  assert.equal(value(ownModel), '14');
  assert.equal(value(otherModel), '2', 'the other model has a flat and an instanced object');
  assert.equal(value(ownObject), '2', 'flat and instanced pieces of one object are added');
  const providers = prepareListProviders(useViewerStore.getState(), {});
  const result = executeList(definition, providers.pairs.find(pair => pair.modelId === 'A')!.provider);
  assert.deepEqual(result.rows.map(row => [row.entityId, row.values[0]]), [[3, 12], [2, 2]], '12 sorts ahead of 2 numerically');
  assert.equal(result.columns[0].quantityType, undefined, 'counts do not acquire model length units');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'B')!.provider.getTriangleCount?.(2), 1);
  await act(async () => { scene.removeMeshesForEntity(2); await Promise.resolve(); });
  assert.equal(value(ownModel), '12');
  assert.equal(value(ownObject), '0');
  assert.equal(value(otherModel), '2');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'A')!.provider.getTriangleCount?.(2), 0, 'a prepared provider reads current topology');
  const replacement = new Scene();
  await act(async () => {
    setGlobalRendererRef({ current: { getScene: () => replacement } as unknown as Renderer });
  });
  assert.equal(value(ownModel), '—', 'a completed model has not reached the replacement Scene');
  assert.equal(value(ownObject), '—');
  assert.equal(value(otherModel), '—');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'A')!.provider.getTriangleCount?.(2), null);
  await act(async () => { replacement.queueMeshes([triangle(2)]); await Promise.resolve(); });
  assert.equal(value(ownModel), '—', 'the replacement viewport has not completed its source replay');
  assert.equal(value(ownObject), '—');
  assert.equal(value(otherModel), '—', 'A replay does not establish B source availability (#10370 review)');
  assert.equal(value(otherObject), '—', 'an unreplayed object is unavailable, not zero');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'B')!.provider.getTriangleCount?.(2), null);
  await act(async () => { replacement.queueMeshes([triangle(federationRegistry.toGlobalId('B', 2))]); await Promise.resolve(); });
  assert.equal(value(otherModel), '—', 'one B source does not prove the whole model replayed (#10370 review)');
  assert.equal(value(unreplayedObject), '—', 'unreplayed B object 3 must not report zero');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'B')!.provider.getTriangleCount?.(3), null);
  await act(async () => {
    replacement.queueMeshes([triangle(federationRegistry.toGlobalId('B', 3))]);
    replacement.setTriangleCountReplayComplete(true);
    await Promise.resolve();
  });
  assert.equal(value(ownModel), '1', 'the row recovers when source geometry is replayed');
  assert.equal(value(ownObject), '1');
  assert.equal(value(otherModel), '2');
  assert.equal(value(otherObject), '1');
  assert.equal(value(unreplayedObject), '1');
  assert.equal(providers.pairs.find(pair => pair.modelId === 'A')!.provider.getTriangleCount?.(2), 1);
});
