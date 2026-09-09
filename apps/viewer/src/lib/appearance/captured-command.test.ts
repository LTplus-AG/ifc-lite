/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { texturedProductSource as source, texturedProductPng as png } from '@/test/textured-product-fixture';
import { rebuildSpatialHierarchy } from '@/utils/spatialHierarchy';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { entityRefToString } from '@/store/types';
import { createIfcFromCapturedMesh } from './create-captured-mesh';
import { createAppearancePlanner, type AppearanceWorker } from './planner-worker-client';
import type { CapturedMeshRequest } from './planner-types';
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import { prepareAppearanceSerialization } from './serialization';
const wasmOptions = { skip: !existsSync(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) && 'Build WASM with pnpm build:wasm' };
const geometryMesh = (): CapturedMeshRequest['mesh'] => ({ positions: [[12,23,34],[13,23,34],[13,24,34],[12,24,35]],
  triangles: [[0,1,2],[0,2,3]], uvs: [[0,0],[1,0],[1,1],[0,1],[0.2,0.2]], uvTriangles: [[0,1,2],[4,2,3]] });
afterEach(() => {
  useViewerStore.getState().clearAllMutations();
  useViewerStore.setState({ models: new Map(), mutationViews: new Map(), geometryResult: null, modelPlacement: emptyPlacementState() });
  modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
});
async function setup(federated = false) {
  const data = await new IfcParser().parseColumnar(source.slice().buffer);
  data.spatialHierarchy = rebuildSpatialHierarchy(data.entities, data.relationships);
  const view = new MutablePropertyView(data.properties, 'capture');
  const editor = new StoreEditor(data, view);
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const geometry: GeometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  if (federated) federationRegistry.registerModel('other', 100);
  const idOffset = federationRegistry.registerModel('capture', 53);
  const model = { ...fixtureModel('capture'), schemaVersion: 'IFC4' as const, idOffset, maxExpressId: 53, ifcDataStore: data, geometryResult: geometry };
  const other = fixtureModel('other');
  useViewerStore.setState({ models: new Map([...(federated ? [['other', other] as const] : []), ['capture', model]]), activeModelId: 'capture',
    geometryResult: geometry, mutationViews: new Map([['capture', view]]), storeEditors: new Map([['capture', editor]]),
    undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null,
    modelPlacement: { ...emptyPlacementState(), placements: new Map([['capture', { translation: [10,20,30], locked: false }]]) } });
  const asset = await appearanceAssets.add(png, { owner: { kind: 'draft', id: 'capture-test' } });
  const meshes = new Map<number, MeshData>();
  const renderer = { prepareTexturedOwner(mesh: MeshData) {
    return { commit() { meshes.set(mesh.expressId, mesh); }, dispose() {} };
  }, getScene: () => ({ getMeshDataPieces(id: number) { const mesh = meshes.get(id); return mesh ? [mesh] : undefined; },
    removeMeshesForEntities(ids: Iterable<number>) { for (const id of ids) meshes.delete(id); } }), requestRender() {}, invalidateBVHCache() {} } as unknown as Renderer;
  return { data, view, asset, meshes, renderer, other };
}
async function nativePlanner(afterNative: () => void = () => {}) {
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
  const { runCapturedMeshPlanning } = await import('../../workers/appearance.worker');
  let request: CapturedMeshRequest | undefined;
  const planner = createAppearancePlanner({ workerFactory: () => {
    const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null, terminate() {},
      postMessage(job) {
        if (job.type !== 'captured-mesh-plan') throw new Error('Unexpected job');
        request = structuredClone(job.request);
        void runCapturedMeshPlanning(job.source, request).then(result => {
          afterNative(); worker.onmessage?.(new MessageEvent('message', { data: { type: 'captured-mesh-complete', id: job.id, result } }));
        }, error => worker.onmessage?.(new MessageEvent('message', { data: { type: 'error', id: job.id, message: String(error) } })));
      } };
    return worker;
  } });
  return { planner, request: () => request };
}
for (const federated of [false, true]) test(`captured wrapper owns placement, identity, Undo and exact portable image (${federated ? 'federated' : 'single'}) #4380`, wasmOptions, async () => {
  const fixture = await setup(federated), native = await nativePlanner();
  const oldDecode = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (async () => ({ width: 1, height: 1, close() {} })) as typeof createImageBitmap;
  try {
    const mesh = geometryMesh();
    const work = createIfcFromCapturedMesh('capture', 40, { assetId: fixture.asset.id, mesh, repeatS: true, repeatT: false, validate() {} }, fixture.renderer, { planner: native.planner });
    mesh.positions[0][0] = 999; mesh.uvs[0][0] = 0.9;
    const result = await work;
    assert.deepEqual(native.request()!.mesh.positions[0], [2,3,4], 'translation is removed exactly once and caller mutations cannot replace the captured snapshot');
    assert.deepEqual(native.request()!.mesh.uvs[0], [0,0]);
    assert.equal(native.request()!.repeatS, true);
    assert.equal(native.request()!.repeatT, false);
    assert.deepEqual(useViewerStore.getState().resolveGlobalIdFromModels(result.globalId), { modelId: 'capture', expressId: result.expressId });
    const rendered = fixture.meshes.get(result.globalId)!;
    const first = rendered.indices[0];
    assert.deepEqual(Array.from(rendered.positions.slice(first*3,first*3+3)).map((p,i)=>p+(rendered.origin?.[i]??0)), [2,4,-3], 'canonical mesh remains in model coordinates; existing model transform supplies [10,30,-20]');
    const serialization = prepareAppearanceSerialization('capture', fixture.data, fixture.view);
    assert.deepEqual([...serialization.resources.exportResources().resources.values()][0], png);
    const exported = await new StepExporter(fixture.data, serialization.view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
    const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer);
    assert.equal(reopened.entities.getTypeName(result.expressId), 'IfcBuildingElementProxy');
    assert.equal(rebuildSpatialHierarchy(reopened.entities, reopened.relationships)!.elementToContainer?.get(result.expressId), 40);
    const ref = { modelId: 'capture', expressId: result.expressId };
    useViewerStore.setState({ selectedEntityId: result.globalId, selectedEntityIds: new Set([result.globalId]), selectedEntity: ref,
      selectedEntities: [ref], selectedEntitiesSet: new Set([entityRefToString(ref)]) });
    useViewerStore.getState().undo('capture');
    assert.equal(fixture.meshes.size, 0); assert.equal(useViewerStore.getState().selectedEntityId, null);
    assert.equal(fixture.view.getNewEntities().length, 0);
    useViewerStore.getState().redo('capture');
    assert.equal(fixture.meshes.size, 1);
    assert.equal(useViewerStore.getState().resolveGlobalIdFromModels(result.globalId)?.expressId, result.expressId);
    assert.deepEqual([...modelAppearanceAssets.exportResources('capture').resources.values()][0], png);
    if (federated) assert.equal(useViewerStore.getState().models.get('other'), fixture.other);
  } finally { native.planner.dispose(); globalThis.createImageBitmap = oldDecode; }
});
for (const failure of ['source', 'model', 'cancel'] as const) test(`capture ${failure} changing during native planning prevents publication #4380`, wasmOptions, async () => {
  const fixture = await setup(); let stale = false;
  const abort = new AbortController();
  const native = await nativePlanner(() => {
    if (failure === 'source') stale = true;
    if (failure === 'model') useViewerStore.setState({ models: new Map() });
    if (failure === 'cancel') abort.abort();
  });
  const allocation = fixture.view.peekNextExpressId();
  try {
    await assert.rejects(createIfcFromCapturedMesh('capture', 40, { assetId: fixture.asset.id, mesh: geometryMesh(),
      validate() { if (stale) throw new Error('Capture changed'); } }, fixture.renderer, { planner: native.planner, signal: abort.signal }), /changed|cancelled/i);
    assert.equal(fixture.meshes.size, 0); assert.equal(fixture.view.getNewEntities().length, 0);
    assert.equal(fixture.view.peekNextExpressId(), allocation);
    assert.equal(useViewerStore.getState().undoStacks.get('capture')?.length ?? 0, 0);
    assert.equal(modelAppearanceAssets.exportResources('capture').resources.size, 0);
  } finally { native.planner.dispose(); }
});
