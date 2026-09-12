/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { StrictMode, act } from 'react';
import { IfcParser, unwrapIfcZipWithResources } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { federationRegistry, Raycaster, Renderer as PreviewRenderer, type Renderer } from '@ifc-lite/renderer';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { AppearancePreviewController } from '../../../../../../packages/renderer/src/appearance-preview.js';
import { render, cleanup, advance, type } from '@/test/render.js';
import { AppearanceStreamingHarness } from '@/test/appearance-streaming-harness.js';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { faceMaskProductSource } from '@/test/face-mask-fixture.js';
import { texturedProductPng as png } from '@/test/textured-product-fixture.js';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import { prepareAppearanceSerialization } from '@/lib/appearance/serialization.js';
import { packagePortableIfcAsync } from '@/lib/export/portable-ifc.js';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client.js';
import type { AppearancePlan, AppearanceCatalog, AppearanceRequest, AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types.js';
import { AppearancePanel } from './AppearancePanel.js';
import { AuthorTab } from '../ribbon/tabs/AuthorTab.js';

// The mapped quad in the renderer frame (IFC Z-up -> Y-up): four corners, two
// triangles. Both occurrences render it; only the chosen one is converted.
const wasmUrl = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]);
const normals = new Float32Array(12).map((_, i) => i % 3 === 1 ? 1 : 0);

for (const instanced of [false, true]) test(`mounted ${instanced ? 'instanced' : 'resident'} face selection previews a split, survives discard, applies, exports and undoes/redoes (#4404)`, {
  skip: !existsSync(wasmUrl) && 'Run pnpm build:wasm for the native appearance contract',
}, async () => {
  const initial = useViewerStore.getState(), previousRenderer = getGlobalRenderer();
  modelIndices(new Map());
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const oldDecode = globalThis.createImageBitmap;
  const capture = HTMLElement.prototype.setPointerCapture;
  let instanceScene: ReturnType<typeof appearanceInstanceScene> | undefined;
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const requests: { request: AppearanceRequest; plan: AppearancePlan }[] = [];
  class NativeWorker implements AppearanceWorker {
    onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror = null;
    stopped = false;
    terminate() { this.stopped = true; }
    postMessage(job: AppearanceWorkerRequest) {
      queueMicrotask(() => {
        if (this.stopped) return;
        const api = new IfcAPI();
        try {
          let response: AppearanceWorkerResponse;
          if (job.type === 'catalog') response = { type: 'catalog-complete', id: job.id,
            catalog: JSON.parse(new TextDecoder().decode(api.catalogAppearance(new Uint8Array(job.source), JSON.stringify(job.request)))) as AppearanceCatalog };
          else if (job.type === 'plan') {
            const plan = JSON.parse(new TextDecoder().decode(api.planAppearance(new Uint8Array(job.source), JSON.stringify(job.request)))) as AppearancePlan;
            requests.push({ request: job.request, plan }); response = { type: 'complete', id: job.id, plan };
          } else throw new Error('Unexpected native fixture request');
          this.onmessage?.({ data: response } as MessageEvent<AppearanceWorkerResponse>);
        } catch (error) { this.onerror?.({ message: String(error) } as ErrorEvent); }
        finally { api.free(); }
      });
    }
  }
  try {
    const source = faceMaskProductSource();
    const data = await new IfcParser().parseColumnar(source.slice().buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(data.properties, 'evaluated');
    const idOffset = federationRegistry.registerModel('evaluated', 80);
    const globalId = (id: number) => federationRegistry.toGlobalId('evaluated', id);
    const makeMesh = (id: number): MeshData => ({ expressId: globalId(id), geometryItemId: globalId(11), modelIndex: 0, positions, normals, indices,
      color: [0.8, 0.2, 0.1, 1], appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } });
    const originals = [makeMesh(25), makeMesh(35)];
    const resident = new Map(originals.map(mesh => [mesh.expressId, [mesh] as readonly MeshData[]]));
    const bounds = { min: { x: 0, y: 0, z: -1 }, max: { x: 1, y: 0, z: 0 } };
    const geometry: GeometryResult = { meshes: instanced ? [] : originals, totalTriangles: instanced ? 0 : 4, totalVertices: instanced ? 0 : 8,
      ...(instanced ? { instancedGeometryAabbs: new Map(originals.map(mesh => [mesh.expressId, { min: [0, 0, -1] as [number, number, number], max: [1, 0, 0] as [number, number, number] }])) } : {}),
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
    const model = { ...fixtureModel('evaluated'), idOffset, maxExpressId: 80, ifcDataStore: data, geometryResult: geometry, schemaVersion: 'IFC4' as const, loadState: 'complete' as const };
    const selection = globalId(25);
    useViewerStore.setState({ models: new Map([['evaluated', model]]), activeModelId: 'evaluated',
      geometryResult: geometry, mutationViews: new Map([['evaluated', view]]), storeEditors: new Map([['evaluated', new StoreEditor(data, view)]]),
      undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null,
      appearanceSources: [], appearanceDraft: null, selectedEntityId: selection, selectedEntityIds: new Set([selection]) });
    const owner = { kind: 'source' as const, id: 'face-mask-image' };
    const asset = await appearanceAssets.add(png, { owner });
    useViewerStore.getState().addAppearanceSource({ id: asset.id, name: 'Texture', width: 1, height: 1 });
    globalThis.createImageBitmap = async (blob: ImageBitmapSource) => {
      assert.ok(blob instanceof Blob); const bytes = new DataView(await blob.arrayBuffer());
      return { width: bytes.getUint32(16), height: bytes.getUint32(20), close() {} } as ImageBitmap;
    };
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NativeWorker });
    // The face-selection canvas has no GPU here: its renderer is a stub and the
    // hit test answers "triangle 1" for any click. What is asserted is the
    // selection's effect on the plan, the scene, the IFC and history.
    const init = mock.method(PreviewRenderer.prototype, 'init', async () => {});
    mock.method(PreviewRenderer.prototype, 'loadGeometry', () => {});
    mock.method(PreviewRenderer.prototype, 'render', () => {});
    mock.method(PreviewRenderer.prototype, 'fitToView', () => {});
    mock.method(Raycaster.prototype, 'raycast', () => ({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, distance: 1, meshIndex: 0, triangleIndex: 1, expressId: selection, barycentricCoord: { u: 0.3, v: 0.3, w: 0.4 } }));
    HTMLElement.prototype.setPointerCapture = () => {};
    const gpu = new AppearancePreviewController<number>({ capture: owner => ({ parts: resident.get(owner.expressId)!, resources: [] }),
      stage: () => [], install: (owner, parts) => { resident.set(owner.expressId, parts); }, release() {} });
    // Instanced shards take their template in IFC Z-up; the scene converts.
    if (instanced) instanceScene = appearanceInstanceScene(originals, { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normals: new Float32Array(12).map((_, i) => i % 3 === 2 ? 1 : 0), indices });
    const activePreview = instanceScene?.preview ?? gpu;
    const readParts = (id: number) => instanceScene
      ? activePreview.getParts?.({ expressId: id, modelIndex: 0 }) ?? instanceScene.scene.getInstancedMeshDataPieces(id)
      : resident.get(id);
    const siblingBefore = readParts(globalId(35))!;
    const renderer = { getAppearancePreview: () => activePreview,
      getScene: () => instanceScene?.scene ?? { getMeshDataPieces: (id: number) => resident.get(id) }, requestRender() {},
      getGPUDevice: () => instanceScene?.device, getPipeline: () => instanceScene?.pipeline, getCanvas: () => null, clearCaches() {},
      getCamera: () => ({ fitBoundsAdaptive: () => ({ kind: 'compact' }), getPosition: () => ({ x: 0, y: 0, z: 0 }), getTarget: () => ({ x: 0, y: 0, z: 0 }), setSceneBounds() {}, setOrbitAnchorBounds() {}, reset() {} }) } as unknown as Renderer;
    setGlobalRendererRef({ current: renderer });
    const ui = render(<StrictMode>{instanced && <AppearanceStreamingHarness renderer={renderer} />}<AppearancePanel /><AuthorTab /></StrictMode>);
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await advance(10); assert.ok(predicate(), ui.textContent ?? 'UI stalled'); };
    const button = (name: string) => [...ui.querySelectorAll('button')].find(item => item.textContent?.trim() === name)!;
    const ids = (id: number) => readParts(id)!.map(part => part.geometryItemId);
    await until(() => requests.length > 0);
    const consent = ui.querySelector<HTMLInputElement>('input[type=checkbox]'); assert.ok(consent);
    await act(async () => consent.click());
    await until(() => !!button('Apply') && !button('Apply').disabled);
    const whole = requests.at(-1)!;
    assert.equal(whole.request.faceMasks, undefined);
    assert.equal(whole.plan.conversions?.length, 1); assert.equal(whole.plan.conversions![0].sourceIndices.length, 6);
    assert.match(ui.textContent ?? '', /all 2 faces/);
    assert.deepEqual(ids(selection), [globalId(whole.plan.conversions![0].geometryItemId)], 'a whole-surface conversion previews as one textured part');

    // Select one of the two faces: the plan carries the mask, the preview splits.
    await act(async () => button('Select faces').click());
    const editor = ui.querySelector(`[aria-label="Face selection for IFC object #25"]`); assert.ok(editor, 'the face editor opens for the converted object');
    await act(async () => button('Pick faces').click());
    const canvas = editor.querySelector('canvas')!;
    const pointer = (type: string) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 }));
    const editorRenderers = init.mock.callCount();
    assert.ok(editorRenderers > 0, 'the face editor owns a renderer');
    await act(async () => { pointer('pointerdown'); pointer('pointerup'); });
    await until(() => requests.at(-1)!.request.faceMasks !== undefined && ui.textContent!.includes('Preview ready'));
    assert.equal(init.mock.callCount(), editorRenderers, 'a face click and its re-plan keep the editor renderer and camera: the surface identity is stable');
    const masked = requests.at(-1)!;
    assert.deepEqual(masked.request.faceMasks, [{ productId: 25, surfaceFingerprint: whole.plan.conversions![0].surfaceFingerprint, triangles: [1] }]);
    assert.deepEqual(masked.plan.exclusions, []);
    const conversion = masked.plan.conversions![0];
    assert.deepEqual(conversion.maskedTriangles, [1]);
    const textured = globalId(conversion.geometryItemId), retained = globalId(conversion.retainedGeometryItemId!);
    assert.deepEqual(ids(selection), [textured, retained], 'the masked preview stages the textured and the retained face set under one owner');
    assert.equal(readParts(selection)![0].indices.length, 3); assert.equal(readParts(selection)![1].indices.length, 3);
    assert.ok(readParts(selection)![0].uvs && (readParts(selection)![0].textureRef || readParts(selection)![0].texture));
    assert.equal(readParts(selection)![1].uvs, undefined);
    assert.deepEqual([...readParts(selection)![1].color], [0.8, 0.2, 0.1, 1], 'the retained part keeps the source colour');
    assert.match(ui.textContent ?? '', /1 of 2 faces selected/);
    assert.deepEqual(readParts(globalId(35))!, siblingBefore);
    assert.equal(view.getNewEntities().length, 0, 'preview publishes no IFC conversion');

    // Leaving the evaluated policy keeps the selection dormant: no mask enters a
    // preserve-policy request (a request-shape fault), the policy's own
    // exclusion shows, and the selection returns with the policy.
    const beforePolicy = requests.length;
    await act(async () => consent.click());
    await until(() => requests.length > beforePolicy && requests.at(-1)!.request.representationPolicy === 'preserve');
    const preserved = requests.at(-1)!;
    assert.equal(preserved.request.faceMasks, undefined, 'a face selection never enters a preserve-policy request');
    assert.ok(preserved.plan.exclusions.length > 0 && preserved.plan.exclusions.every(item => !item.reason.startsWith('Face')), 'only the policy exclusion remains');
    await until(() => (ui.textContent ?? '').includes(preserved.plan.exclusions[0].reason));
    assert.doesNotMatch(ui.textContent ?? '', /Face masks require|faces selected/, 'the panel shows the policy refusal, not the request-shape fault');
    assert.ok(!button('Apply') || button('Apply').disabled, 'a refused plan cannot be applied');
    await act(async () => consent.click());
    await until(() => requests.length > beforePolicy + 1 && requests.at(-1)!.request.faceMasks !== undefined && (ui.textContent ?? '').includes('Preview ready'));
    assert.deepEqual(requests.at(-1)!.request.faceMasks?.[0].triangles, [1], 'the dormant selection returns with the evaluated policy');
    assert.deepEqual(ids(selection), [textured, retained]);
    assert.match(ui.textContent ?? '', /1 of 2 faces selected/);
    await act(async () => button('Compare original').click());
    assert.deepEqual(ids(selection), [globalId(11)]);
    await act(async () => button('Show preview').click());
    assert.deepEqual(ids(selection), [textured, retained]);

    // Discard restores the single original part and keeps the selection for the next preview.
    await act(async () => button('Discard').click());
    await until(() => (ui.textContent ?? '').includes('Preview discarded'));
    assert.deepEqual(ids(selection), [globalId(11)]);
    const tile = ui.querySelector<HTMLInputElement>('input[aria-label="Tile width (m)"]') ?? [...ui.querySelectorAll('label')].find(label => label.textContent?.includes('Tile width'))?.querySelector('input');
    assert.ok(tile, 'a mapping field re-enables the preview');
    const planned = requests.length;
    type(tile, '2');
    await until(() => requests.length > planned && !!button('Apply') && !button('Apply').disabled);
    const again = requests.at(-1)!;
    assert.deepEqual(again.request.faceMasks?.[0].triangles, [1], 'the selection survives Discard');
    assert.deepEqual(ids(selection), [textured, retained]);

    // Apply: one history step, two face sets in the IFC, the sibling untouched, selection intact.
    await act(async () => button('Apply').click());
    await until(() => (useViewerStore.getState().undoStacks.get('evaluated')?.length ?? 0) === 1);
    assert.equal(useViewerStore.getState().selectedEntityId, selection);
    assert.deepEqual(ids(selection), [textured, retained]);
    const applied = useViewerStore.getState().models.get('evaluated')!.geometryResult!.meshes.filter(mesh => mesh.expressId === selection);
    assert.deepEqual(applied.map(mesh => mesh.geometryItemId), [textured, retained], 'the model geometry carries both parts of the product');
    assert.deepEqual(readParts(globalId(35))!, siblingBefore);
    assert.doesNotMatch(ui.textContent ?? '', /faces selected/, 'the applied selection is spent');
    const faceSets = view.getNewEntities().filter(entity => entity.type === 'IfcTriangulatedFaceSet').map(entity => entity.expressId);
    assert.deepEqual(faceSets, [conversion.geometryItemId, conversion.retainedGeometryItemId]);
    const serialized = prepareAppearanceSerialization('evaluated', data, view);
    const output = await new StepExporter(data, serialized.view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const text = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    assert.match(text, new RegExp(`#23=IFCSHAPEREPRESENTATION\\(#2,'Body','Tessellation',\\(#${faceSets[0]},#${faceSets[1]}\\)\\)`), 'the occurrence Body lists both face sets');
    assert.match(text, /#33=IFCSHAPEREPRESENTATION\(#2,'Body','MappedRepresentation',\(#22\)\)/, 'the sibling keeps its mapped Body');
    assert.equal((text.match(/IFCTRIANGULATEDFACESET\(/g) ?? []).length, 3, 'source quad plus textured and retained face sets');
    const archive = await unwrapIfcZipWithResources(new Uint8Array((await packagePortableIfcAsync('evaluated', text, serialized.resources)).content as Uint8Array).buffer);
    assert.deepEqual([...archive.originalResources.values()][0], png, 'the portable archive carries the image');
    const reopened = await new IfcParser().parseColumnar(archive.model, { disableWorkerScan: true });
    assert.equal(reopened.entities.getGlobalId(25), '0Proxy000000000000000a');
    assert.ok(reopened.entityIndex.byId.has(faceSets[0]) && reopened.entityIndex.byId.has(faceSets[1]));

    // Undo joins the parts back into the original; Redo splits them again.
    await act(async () => { const undo = ui.querySelector<HTMLButtonElement>('button[aria-label="Undo"]'); assert.ok(undo && !undo.disabled); undo.click(); });
    assert.equal(view.getNewEntities().length, 0);
    assert.deepEqual(ids(selection), [globalId(11)]);
    if (instanced) assert.equal(useViewerStore.getState().models.get('evaluated')!.geometryResult!.meshes.length, 0);
    await act(async () => { const redo = ui.querySelector<HTMLButtonElement>('button[aria-label="Redo"]'); assert.ok(redo && !redo.disabled); redo.click(); });
    assert.deepEqual(ids(selection), [textured, retained]);
    assert.equal(view.getNewEntities().filter(entity => entity.type === 'IfcTriangulatedFaceSet').length, 2);
    assert.deepEqual(readParts(globalId(35))!, siblingBefore);
  } finally {
    cleanup(); instanceScene?.scene.clear(); setGlobalRendererRef({ current: previousRenderer });
    mock.restoreAll(); HTMLElement.prototype.setPointerCapture = capture;
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor); else Reflect.deleteProperty(globalThis, 'Worker');
    globalThis.createImageBitmap = oldDecode;
    useViewerStore.getState().clearAllMutations(); modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
    useViewerStore.setState(initial);
    modelIndices(new Map());
  }
});
