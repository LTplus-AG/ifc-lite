/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { rebuildSpatialHierarchy } from '@/utils/spatialHierarchy';
import { annotationFrame } from './create-annotation';
import { commitAnnotationPlane } from './annotation-command';
import { appearanceRevision, captureAppearanceSource } from './command';
import { appearanceAssets, modelAppearanceAssets } from './model-assets';
import { prepareAppearanceSerialization } from './serialization';
import { StepExporter } from '@ifc-lite/export';
import type { AnnotationPlanePlan } from './planner-types';
const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('annotation creation contract'),'2;1');
FILE_NAME('plane.ifc','2026-09-09',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project000000000000000',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCRELAGGREGATES('0ccccccccccccccccccccc',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;`);
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
afterEach(() => {
  useViewerStore.getState().clearAllMutations();
  useViewerStore.setState({ models: new Map(), mutationViews: new Map(), geometryResult: null });
  modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
});

for (const federated of [false, true]) test(`native annotation commit survives undo, redo and portable export with ${federated ? 'federated' : 'single'} owner (#4308)`, async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  let wasm: Buffer;
  try { wasm = await readFile(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: wasm });
  const api = new IfcAPI();
  const oldDecode = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (async () => ({ width: 1, height: 1, close() {} })) as typeof createImageBitmap;
  try {
    const data = await new IfcParser().parseColumnar(source.buffer as ArrayBuffer);
    data.spatialHierarchy = rebuildSpatialHierarchy(data.entities, data.relationships);
    assert.ok(data.spatialHierarchy);
    const view = new MutablePropertyView(data.properties, 'annotation');
    const editor = new StoreEditor(data, view);
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    const geometry: GeometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
    if (federated) federationRegistry.registerModel('other', 100);
    const idOffset = federationRegistry.registerModel('annotation', 42);
    const model = { ...fixtureModel('annotation'), idOffset, maxExpressId: 42, ifcDataStore: data, geometryResult: geometry };
    useViewerStore.setState({ models: new Map([...(federated ? [['other', fixtureModel('other')] as const] : []), ['annotation', model]]), activeModelId: 'annotation',
      geometryResult: geometry, mutationViews: new Map([['annotation', view]]), storeEditors: new Map([['annotation', editor]]),
      undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null });
    const asset = await appearanceAssets.add(png, { owner: { kind: 'draft', id: 'test' } });
    const native = JSON.parse(new TextDecoder().decode(api.planAnnotationPlane(source, JSON.stringify({
      schema: 'IFC4', sourceRevision: appearanceRevision('annotation'), nextExpressId: view.peekNextExpressId(),
      containerId: 40, GlobalId: '0aaaaaaaaaaaaaaaaaaaaa', containmentGlobalId: '0bbbbbbbbbbbbbbbbbbbbb',
      Name: 'Registered plan', imageUri: asset.exportName,
      frame: { origin: [2, 3, 4], axisU: [1, 0, 0], axisV: [0, 0, 1], sizeMetres: [2, 1] },
    })))) as AnnotationPlanePlan;
    const meshes = new Map<number, MeshData>();
    // GPU transport only is substituted; native rows, mutation history and export are real.
    const renderer = { prepareTexturedOwner(mesh: MeshData) {
      if (meshes.has(mesh.expressId)) throw new Error('duplicate owner');
      return { commit() { meshes.set(mesh.expressId, mesh); }, dispose() {} };
    }, getScene: () => ({ getMeshDataPieces(id: number) { const mesh = meshes.get(id); return mesh ? [mesh] : undefined; }, removeMeshesForEntities(ids: Iterable<number>) { for (const id of ids) meshes.delete(id); } }), requestRender() {}, invalidateBVHCache() {} } as unknown as Renderer;
    const allocationBefore = view.peekNextExpressId();
    const failingRenderer = { ...renderer, prepareTexturedOwner() { throw new Error('injected GPU preparation failure'); } } as unknown as Renderer;
    await assert.rejects(commitAnnotationPlane('annotation', asset.id, native, 40, failingRenderer, captureAppearanceSource(view)), /injected GPU/);
    assert.equal(view.getNewEntities().length, 0);
    assert.equal(view.peekNextExpressId(), allocationBefore);
    assert.equal(useViewerStore.getState().undoStacks.get('annotation')?.length ?? 0, 0);
    assert.equal(modelAppearanceAssets.exportResources('annotation').resources.size, 0);
    const result = await commitAnnotationPlane('annotation', asset.id, native, 40, renderer, captureAppearanceSource(view));
    assert.equal(result.expressId, native.annotationId);
    assert.equal(useViewerStore.getState().resolveGlobalIdFromModels(result.globalId)?.expressId, native.annotationId);
    assert.equal(meshes.size, 1);
    assert.ok(data.spatialHierarchy.byStorey.get(40)?.includes(native.annotationId));
    const mesh = meshes.get(result.globalId)!;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const u = mesh.uvs![i * 2], v = 1 - mesh.uvs![i * 2 + 1];
      assert.deepEqual(Array.from(mesh.positions.subarray(i * 3, i * 3 + 3)).map((p, a) => p + mesh.origin![a]), [2 + u * 2, 4 + v, -3]);
    }
    const serialized = prepareAppearanceSerialization('annotation', data, view);
    const step = await new StepExporter(data, serialized.view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const exportedBytes = typeof step.content === 'string' ? new TextEncoder().encode(step.content) : step.content;
    const reopened = await new IfcParser().parseColumnar(exportedBytes.slice().buffer);
    assert.equal(reopened.entities.getTypeName(native.annotationId), 'IfcAnnotation');
    assert.match(new TextDecoder().decode(exportedBytes), /IFCINDEXEDTRIANGLETEXTUREMAP/);
    assert.deepEqual([...serialized.resources.exportResources().resources.values()][0], png);
    useViewerStore.getState().undo('annotation');
    assert.equal(meshes.size, 0);
    assert.ok(!data.spatialHierarchy.byStorey.get(40)?.includes(native.annotationId));
    assert.equal(useViewerStore.getState().models.get('annotation')!.geometryResult!.meshes.length, 0);
    useViewerStore.getState().redo('annotation');
    assert.equal(meshes.size, 1);
    assert.equal(useViewerStore.getState().models.get('annotation')!.geometryResult!.meshes.length, 1);
  } finally { api.free(); globalThis.createImageBitmap = oldDecode; }
});

test('reference frame preserves all four corners and rejects a warped quad (#4308)', () => {
  const corners = [[2, 3, 5], [4, 3, 5], [4, 3, 4], [2, 3, 4]] as const;
  assert.deepEqual(annotationFrame({ cornersIfcWorld: corners }), {
    origin: [2, 3, 4], axisU: [1, 0, 0], axisV: [0, 0, 1], sizeMetres: [2, 1],
  });
  assert.throws(() => annotationFrame({ cornersIfcWorld: [corners[0], [4, 4, 5], corners[2], corners[3]] }), /rectangular/);
});
