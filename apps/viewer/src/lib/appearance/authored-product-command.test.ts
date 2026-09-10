/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { texturedProductSource as source } from '@/test/textured-product-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { commitAuthoredProduct } from './authored-product-command';
import { captureAppearanceSource, appearanceRevision } from './command';
import { modelAppearanceAssets } from './model-assets';
import type { PdfFillAnnotationPlan, PdfFillAnnotationRequest } from './pdf/fill-plan-types';

for (const federated of [false, true]) test(`native multicolour PDF owner is one IFC/GPU/history transaction; federation=${federated} (#4406)`, async t => {
  let binary: Buffer;
  try { binary = await readFile(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; t.skip('Build WASM with pnpm build:wasm'); return; }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: binary });
  const api = new IfcAPI();
  try {
    federationRegistry.clear(); modelAppearanceAssets.clear();
    const data = await new IfcParser().parseColumnar(source.slice().buffer);
    const view = new MutablePropertyView(data.properties, 'fill'), editor = new StoreEditor(data, view);
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    const geometry: GeometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
    if (federated) federationRegistry.registerModel('other', 100);
    const idOffset = federationRegistry.registerModel('fill', 53);
    const model = { ...fixtureModel('fill'), idOffset, maxExpressId: 53, ifcDataStore: data, geometryResult: geometry };
    useViewerStore.setState({ models: new Map([...(federated ? [['other', fixtureModel('other')] as const] : []), ['fill', model]]),
      activeModelId: 'fill', geometryResult: geometry, mutationViews: new Map([['fill', view]]), storeEditors: new Map([['fill', editor]]),
      undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null, modelPlacement: emptyPlacementState() });
    const request = JSON.parse(await readFile(new URL('../../../../../docs/architecture/evidence/pdf-fill-annotations/page-1-request.json', import.meta.url), 'utf8')) as PdfFillAnnotationRequest;
    request.nextExpressId = view.peekNextExpressId(); request.sourceRevision = appearanceRevision('fill');
    const native = JSON.parse(new TextDecoder().decode(api.planPdfFillAnnotation(source, JSON.stringify(request)))) as PdfFillAnnotationPlan;
    const meshes = new Map<number, readonly MeshData[]>();
    const renderer = { prepareAuthoredOwner(parts: readonly MeshData[]) {
      assert.equal(new Set(parts.map(part => part.expressId)).size, 1);
      return { commit() { meshes.set(parts[0].expressId, parts); }, dispose() {} };
    }, getScene: () => ({ getMeshDataPieces: (id: number) => meshes.get(id),
      removeMeshesForEntities(ids: Iterable<number>) { for (const id of ids) meshes.delete(id); } }),
    requestRender() {}, invalidateBVHCache() {} } as unknown as Renderer;
    const plan = { ...native, objectId: native.annotationId };
    const before = view.peekNextExpressId();
    const failed = { ...renderer, prepareAuthoredOwner() { throw new Error('injected later-colour allocation failure'); } } as unknown as Renderer;
    await assert.rejects(commitAuthoredProduct('fill', [], plan, request.containerId, failed, captureAppearanceSource(view)), /later-colour/);
    assert.equal(view.peekNextExpressId(), before); assert.equal(view.getNewEntities().length, 0);
    assert.equal(useViewerStore.getState().undoStacks.get('fill')?.length ?? 0, 0);
    const result = await commitAuthoredProduct('fill', [], plan, request.containerId, renderer, captureAppearanceSource(view));
    assert.equal(meshes.get(result.globalId)?.length, 2);
    assert.ok(meshes.get(result.globalId)?.every(part => !part.texture && !part.textureRef && !part.textureBitmap && !part.uvs));
    assert.deepEqual(meshes.get(result.globalId)?.map(part => part.color).sort(), [[0, 0, 1, 1], [1, 0, 0, 1]]);
    for (const [index, part] of meshes.get(result.globalId)!.entries()) {
      const original = native.meshes[index];
      for (let vertex = 0; vertex < part.positions.length; vertex += 3) {
        const world = [0, 1, 2].map(axis => original.positions[vertex + axis] + (original.origin?.[axis] ?? 0) + native.rtcOffset[axis]);
        const expected = [world[0], world[2], -world[1]];
        expected.forEach((value, axis) => assert.ok(Math.abs(part.positions[vertex + axis] + (part.origin?.[axis] ?? 0) - value) < 1e-6));
      }
    }
    assert.equal(useViewerStore.getState().undoStacks.get('fill')?.length, 1);
    assert.equal(modelAppearanceAssets.exportResources('fill').resources.size, 0);
    const exported = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const bytes = typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content;
    const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer);
    assert.equal(reopened.entities.getTypeName(result.expressId), 'IfcAnnotation');
    assert.equal(reopened.entities.getName(result.expressId), request.Name);
    const triangles = native.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
    assert.equal(useViewerStore.getState().models.get('fill')?.geometryResult?.totalTriangles, triangles);
    useViewerStore.getState().undo('fill');
    assert.equal(meshes.size, 0); assert.equal(view.getNewEntities().length, 0);
    assert.equal(useViewerStore.getState().models.get('fill')?.geometryResult?.totalTriangles, 0);
    useViewerStore.getState().redo('fill');
    assert.equal(meshes.get(result.globalId)?.length, 2);
    assert.equal(useViewerStore.getState().models.get('fill')?.geometryResult?.totalTriangles, triangles);
    // A later edit of either part refuses the entire Undo, preserving both parts and IFC rows.
    const originals = meshes.get(result.globalId)!;
    meshes.set(result.globalId, [originals[0], { ...originals[1], positions: new Float32Array(originals[1].positions).fill(3) }]);
    assert.throws(() => useViewerStore.getState().undo('fill'), /geometry changed/);
    assert.equal(meshes.get(result.globalId)?.length, 2); assert.ok(view.getNewEntities().length > 0);
  } finally {
    useViewerStore.setState({ models: new Map(), mutationViews: new Map(), undoStacks: new Map(), redoStacks: new Map() });
    modelAppearanceAssets.clear(); federationRegistry.clear(); api.free();
  }
});
