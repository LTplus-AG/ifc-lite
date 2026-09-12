/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { MergedExporter, StepExporter } from '@ifc-lite/export';
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
import * as collab from '@ifc-lite/collab';
import { prepareShareSeed } from '@/lib/collab/share-scope';
import { roomSlotRef } from '@/lib/collab/model-slot-ref';
import { joiner, localIdOf, ownerShare } from '@/test/collab-room-harness';
import { parseSymbolicAnnotations } from '@/lib/overlay-parse/symbolic-parse';
import { roomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import { roomStepExportSource } from '@/lib/collab/room-step-export';
import { configureMutationView } from '@/utils/configureMutationView';
import { pathForEntity } from '@/lib/collab/entity-paths';
import { resolvePlacementChain } from '@/lib/placement-core';

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

    // Direct Create → Share, with no export/reopen boundary: sharing must
    // materialize the overlay rows while preserving every renderer part that
    // commitAuthoredProduct published for the new IfcAnnotation (#4604).
    const current = useViewerStore.getState();
    const seed = await prepareShareSeed(current.models, current.mutationViews, 'fill', 'active');
    assert.equal(seed.models.length, 1);
    assert.ok(seed.models[0].portableStepSource, 'the effective authored STEP is carried with the room');
    assert.equal(seed.models[0].meshes?.filter(part => part.expressId === result.globalId).length, 2);
    const annotationGuid = seed.models[0].store.entities.getGlobalId(result.expressId);
    assert.ok(annotationGuid);

    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = roomSlotRef(0);
    const annotationPath = `${slot.pathPrefix}/${annotationGuid}`;
    const shared = await ownerShare(doc, blobs, seed.models, new Map([['fill', slot]]));
    assert.deepEqual(shared.outcome, { phase: 'ready', failure: null });
    assert.match(collab.getModelSlot(doc, slot.slotId)?.stepSourceBlobHash ?? '', /^[0-9a-f]{32}$/);
    assert.equal(pathForEntity(data, result.expressId), annotationPath,
      'the owner live store receives the slot-qualified map used by later edits');

    collab.setAttribute(doc, annotationPath, 'bsi::ifc::prop::Name', 'Edited before fresh join');
    collab.setPropertyValue(doc, annotationPath, 'Pset_RoomAcceptance', 'Status', {
      type: 'IfcLabel', value: 'Current room state', source: 'manual',
    });
    const provenance = seed.models[0].store.getProperties(result.expressId)
      .find(pset => pset.name === 'IfcLite_PdfVectorConversion');
    assert.ok(provenance);
    for (const property of provenance.properties) {
      collab.deletePropertyValue(doc, annotationPath, provenance.name, property.name);
    }
    collab.setEntityPlacement(doc, annotationPath, { location: [4, 5, 6], refDirection: [1, 0, 0] });

    const guest = joiner(doc, blobs, `pdf-${federated ? 'federated' : 'single'}`);
    await guest.reconstructor.reconstruct();
    const guestModel = guest.store.state().models.values().next().value;
    assert.ok(guestModel?.ifcDataStore);
    const guestAnnotationId = localIdOf(guestModel, annotationPath);
    assert.equal(guestModel.ifcDataStore.entities.getGlobalId(guestAnnotationId), annotationPath);
    assert.equal(guestModel.ifcDataStore.entities.getName(guestAnnotationId), 'Edited before fresh join');
    assert.ok(
      guestModel.ifcDataStore.properties.getForEntity(guestAnnotationId)
        .some(pset => pset.name === 'Pset_RoomAcceptance'),
      JSON.stringify(guestModel.ifcDataStore.properties.getForEntity(guestAnnotationId)),
    );
    const guestGlobalId = guestModel.idOffset + guestAnnotationId;
    const guestParts = guestModel.geometryResult?.meshes.filter(part => part.expressId === guestGlobalId) ?? [];
    assert.equal(guestParts.length, 2, 'the fresh join hydrates every authored colour part under one selectable owner');
    assert.deepEqual(guestParts.map(part => part.color).sort(), [[0, 0, 1, 1], [1, 0, 0, 1]]);

    const portable = roomSymbolicSource(guestModel.ifcDataStore);
    assert.ok(portable, `the fresh room model retains its complete STEP representation source: ${guest.notices.join('; ')}`);
    const symbolic = await parseSymbolicAnnotations({ source: portable.source.materialize() });
    const symbolicFills = [
      ...symbolic.looseFills,
      ...symbolic.gridLooseFills,
      ...Array.from(symbolic.byStorey.values()).flatMap(bucket => bucket.fills),
    ];
    assert.equal(symbolicFills.length, 2, 'the same fresh-join model retains both native symbolic 2D fills');
    assert.ok(symbolicFills.every(fill => fill.ownerId === result.expressId));
    assert.equal(portable.ownerIds.get(result.expressId), guestAnnotationId);
    assert.deepEqual(portable.placements.get(result.expressId)?.location, [4, 5, 6]);

    const emptyRoomView = new MutablePropertyView(guestModel.ifcDataStore.properties, guestModel.id);
    configureMutationView(emptyRoomView, guestModel.ifcDataStore);
    const bakedRoomSource = roomStepExportSource(guestModel.ifcDataStore, emptyRoomView, guestModel.id);
    assert.ok(bakedRoomSource?.mutationView, 'fresh join state is replayed over the immutable share-time STEP');
    const bakedEditorBeforeExport = new StoreEditor(bakedRoomSource.dataStore, bakedRoomSource.mutationView);
    assert.deepEqual(
      resolvePlacementChain(bakedRoomSource.dataStore, bakedRoomSource.mutationView, bakedEditorBeforeExport, result.expressId)?.coordinates,
      [4, 5, 6],
    );
    const bakedExport = await new StepExporter(bakedRoomSource.dataStore, bakedRoomSource.mutationView).exportAsync({
      schema: 'IFC4', applyMutations: true, includeGeometry: true,
    });
    const bakedBytes = typeof bakedExport.content === 'string'
      ? new TextEncoder().encode(bakedExport.content) : bakedExport.content;
    const bakedText = new TextDecoder().decode(bakedBytes);
    const bakedReopened = await new IfcParser().parseColumnar(bakedBytes.slice().buffer);
    assert.equal(bakedReopened.entities.getName(result.expressId), 'Edited before fresh join');
    assert.match(bakedText, /IFCPROPERTYSET\([^\n]*'Pset_RoomAcceptance'/);
    assert.match(bakedText, /IFCPROPERTYSINGLEVALUE\('Status',[^\n]*'Current room state'/);
    assert.match(bakedText, new RegExp(`IFCRELDEFINESBYPROPERTIES\\([^\\n]*\\(#${result.expressId}\\),#\\d+\\)`));
    assert.doesNotMatch(bakedText, /'IfcLite_PdfVectorConversion'/);
    const bakedView = new MutablePropertyView(bakedReopened.properties, 'reopened');
    configureMutationView(bakedView, bakedReopened);
    const bakedEditor = new StoreEditor(bakedReopened, bakedView);
    assert.deepEqual(resolvePlacementChain(bakedReopened, bakedView, bakedEditor, result.expressId)?.coordinates, [4, 5, 6]);

    const merged = await new MergedExporter([{
      id: guestModel.id,
      name: guestModel.name,
      dataStore: bakedRoomSource.dataStore,
      mutationView: bakedRoomSource.mutationView,
    }]).exportAsync({ schema: 'IFC4', projectStrategy: 'keep-first' });
    assert.match(new TextDecoder().decode(merged.content), /IFCANNOTATION\(/,
      'merged STEP consumes the portable store rather than reconstructed IFCX bytes');
    const roomView = new MutablePropertyView(guestModel.ifcDataStore.properties, guestModel.id);
    configureMutationView(roomView, guestModel.ifcDataStore);
    roomView.setAttribute(guestAnnotationId, 'Name', 'Renamed after fresh join');
    const roomSource = roomStepExportSource(guestModel.ifcDataStore, roomView, guestModel.id);
    assert.ok(roomSource, 'the actual room export resolver selects its portable STEP source');
    assert.deepEqual(roomSource.toSourceIds(new Set([guestAnnotationId])), new Set([result.expressId]));
    assert.equal(roomSource.toSourceIds(null), null, 'no isolation remains no isolation');
    const roomExport = await new StepExporter(roomSource.dataStore, roomSource.mutationView).exportAsync({
      schema: 'IFC4', applyMutations: true, includeGeometry: true,
      georefMutations: { projectedCRS: { name: 'Room export CRS' } },
    });
    const roomBytes = typeof roomExport.content === 'string'
      ? new TextEncoder().encode(roomExport.content)
      : roomExport.content;
    const roomReopened = await new IfcParser().parseColumnar(roomBytes.slice().buffer);
    assert.equal(roomReopened.entities.getTypeName(result.expressId), 'IfcAnnotation');
    assert.equal(roomReopened.entities.getGlobalId(result.expressId), annotationGuid);
    assert.equal(roomReopened.entities.getName(result.expressId), 'Renamed after fresh join');
    assert.equal(roomReopened.entityIndex.byType.get('IFCPROJECTEDCRS')?.length, 1,
      'georeferencing fields resolve against the portable source store');
    const reopenedSymbolic = await parseSymbolicAnnotations({ source: roomReopened.source.materialize() });
    const reopenedFills = [
      ...reopenedSymbolic.looseFills,
      ...reopenedSymbolic.gridLooseFills,
      ...Array.from(reopenedSymbolic.byStorey.values()).flatMap(bucket => bucket.fills),
    ];
    assert.equal(reopenedFills.length, 2, 'room export/reopen retains native symbolic fills');
    guest.reconstructor.teardown();

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
