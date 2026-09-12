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
import { federationRegistry, Renderer as PreviewRenderer, type Renderer } from '@ifc-lite/renderer';
import { GeometryProcessor, type MeshData, type GeometryResult } from '@ifc-lite/geometry';
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
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document.js';
import { registerPdfDocument, removePdfDocument } from '@/lib/appearance/pdf/documents.js';
import { publishPdfRaster } from '@/lib/appearance/pdf/publish-source.js';
import { controlledPdf } from '@/lib/appearance/pdf/fixtures.js';
import { runPdfJob, type PdfEngineBackend, type PdfRasterSurface } from '@/lib/appearance/pdf/engine.js';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client.js';
import type { AppearancePlan, AppearanceCatalog, AppearanceRequest, AppearanceWorkerRequest, AppearanceWorkerResponse, PageAppearancePlan, PageAppearanceRequest } from '@/lib/appearance/planner-types.js';
import { AppearancePanel } from './AppearancePanel.js';
import { AuthorTab } from '../ribbon/tabs/AuthorTab.js';
import { pickViewportAppearanceFace } from './face-mask/viewport-face-picker.js';

// The mapped quad in the renderer frame (IFC Z-up -> Y-up): four corners, two
// triangles. Both occurrences render it; only the chosen one is converted.
const wasmUrl = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]);
const normals = new Float32Array(12).map((_, i) => i % 3 === 1 ? 1 : 0);

interface RasterPixels { width: number; height: number; rgba: Uint8ClampedArray }

function meshSnapshot(parts: readonly MeshData[]) {
  return parts.map(part => ({
    expressId: part.expressId, geometryItemId: part.geometryItemId, modelIndex: part.modelIndex, ifcType: part.ifcType,
    positions: [...part.positions], normals: [...part.normals], indices: [...part.indices], color: [...part.color],
    shadingColor: part.shadingColor && [...part.shadingColor], uvs: part.uvs && [...part.uvs],
    texture: part.texture && { width: part.texture.width, height: part.texture.height, rgba: [...part.texture.rgba] },
    textureRef: part.textureRef && { ...part.textureRef },
    appearanceSource: part.appearanceSource && { kind: part.appearanceSource.kind,
      indices: [...part.appearanceSource.indices], sourceIndices: [...part.appearanceSource.sourceIndices],
      cornerIndices: part.appearanceSource.cornerIndices && [...part.appearanceSource.cornerIndices] },
  }));
}

function assertCanonicalFragments(parts: readonly MeshData[], expected: readonly (readonly number[])[], message: string): void {
  const canonicalIndices = parts[0]?.appearanceSource?.sourceIndices;
  assert.ok(canonicalIndices && canonicalIndices.length === indices.length, `${message}: the complete canonical item is retained`);
  const actual = parts.map(part => {
    const source = part.appearanceSource;
    assert.ok(source?.cornerIndices, `${message}: each fragment retains canonical corners`);
    assert.deepEqual([...source.sourceIndices], [...canonicalIndices], `${message}: every fragment names the same canonical item index buffer`);
    const corners = [...source.cornerIndices];
    assert.equal(corners.length, part.indices.length, `${message}: every rendered corner has canonical provenance`);
    return corners;
  }).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(actual, expected, message);
  assert.deepEqual(actual.map(corners => corners[0] / 3), expected.map(corners => corners[0] / 3),
    `${message}: canonical source triangle ordinals remain stable`);
}

function requireRasterPixels(raster: RasterPixels | undefined): RasterPixels {
  if (!raster) throw new Error('the PDF backend must expose the exact pixels used to encode its page derivative');
  return raster;
}

async function pdfBackend(onRaster: (raster: RasterPixels) => void): Promise<PdfEngineBackend> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  type NativeCanvas = HTMLCanvasElement & { toBuffer(type: string): Uint8Array };
  type Target = { canvas: NativeCanvas; context: CanvasRenderingContext2D };
  let factory: { create(width: number, height: number): Target; destroy(target: Target): void };
  return { getDocument(options) {
    const task = pdf.getDocument(options);
    void task.promise.then(document => { factory = document.canvasFactory as typeof factory; }, () => {});
    return task;
  }, options: { disableFontFace: true, useSystemFonts: false },
  surface(width, height): PdfRasterSurface {
    const target = factory.create(width, height);
    return { ...target, async png() {
      onRaster({ width, height, rgba: new Uint8ClampedArray(target.context.getImageData(0, 0, width, height).data) });
      return new Uint8Array(target.canvas.toBuffer('image/png'));
    }, dispose() { factory.destroy(target); } };
  } };
}

for (const mode of ['resident-image', 'instanced-image', 'fragmented-pdf'] as const) test(`mounted ${mode} face selection previews a split, survives discard, applies, exports and undoes/redoes (#4404, #4557)`, {
  skip: !existsSync(wasmUrl) && 'Run pnpm build:wasm for the native appearance contract',
}, async () => {
  const instanced = mode === 'instanced-image', pageSource = mode === 'fragmented-pdf';
  const initial = useViewerStore.getState(), previousRenderer = getGlobalRenderer();
  modelIndices(new Map());
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const oldDecode = globalThis.createImageBitmap;
  const capture = HTMLElement.prototype.setPointerCapture;
  const canvasDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  let pdfKey: string | undefined;
  let instanceScene: ReturnType<typeof appearanceInstanceScene> | undefined;
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const requests: Array<{ request: AppearanceRequest; plan: AppearancePlan; page?: PageAppearanceRequest; rgba?: Uint8Array; result?: PageAppearancePlan }> = [];
  class NativeWorker implements AppearanceWorker {
    onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror = null;
    stopped = false;
    terminate() { this.stopped = true; }
    postMessage(job: AppearanceWorkerRequest) {
      queueMicrotask(async () => {
        if (this.stopped) return;
        const api = new IfcAPI();
        try {
          let response: AppearanceWorkerResponse;
          if (job.type === 'catalog') response = { type: 'catalog-complete', id: job.id,
            catalog: JSON.parse(new TextDecoder().decode(api.catalogAppearance(new Uint8Array(job.source), JSON.stringify(job.request)))) as AppearanceCatalog };
          else if (job.type === 'plan') {
            const plan = JSON.parse(new TextDecoder().decode(api.planAppearance(new Uint8Array(job.source), JSON.stringify(job.request)))) as AppearancePlan;
            requests.push({ request: job.request, plan }); response = { type: 'complete', id: job.id, plan };
          } else if (job.type === 'page-plan') {
            const result = await import('@/workers/appearance.worker.js').then(module => module.runPageAppearancePlanning(new Uint8Array(job.source), job.request, job.rgba));
            requests.push({ request: job.request.appearance, plan: result.plan, page: job.request, rgba: job.rgba.slice(), result });
            response = { type: 'page-complete', id: job.id, result };
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
    const fragment = (mesh: MeshData, from: number): MeshData => {
      const part = mesh.indices.slice(from, from + 3);
      return { ...mesh, indices: part, appearanceSource: { kind: 'canonical-item', indices: part,
        sourceIndices: mesh.indices, cornerIndices: Uint32Array.from([from, from + 1, from + 2]) } };
    };
    const resident = new Map<number, MeshData[]>(originals.map(mesh => [mesh.expressId,
      pageSource && mesh.expressId === globalId(25) ? [fragment(mesh, 0), fragment(mesh, 3)] : [mesh]]));
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
    let decodedPdf: RasterPixels | undefined;
    if (pageSource) {
      const bytes = controlledPdf(), backend = await pdfBackend(raster => { decodedPdf = raster; });
      const document = await PdfAppearanceSource.open(new File([bytes], 'Controlled plan.pdf', { type: 'application/pdf' }), appearanceAssets, {
        worker: { run: (source, job, options) => runPdfJob(backend, source, job, options), cancel() {}, dispose() {} },
      });
      pdfKey = registerPdfDocument(document);
      const raster = await document.rasterize({ pageNumber: 1, dpi: 18 });
      const pagePng = appearanceAssets.encoded(raster.asset.id);
      assert.ok(raster.recipe.pixelWidth > 1 && raster.recipe.pixelWidth <= 256
        && raster.recipe.pixelHeight > 1 && raster.recipe.pixelHeight <= 256 && pagePng.length > 100,
      'real PDF.js decoded a bounded page derivative');
      const rasterPixels = requireRasterPixels(decodedPdf);
      decodedPdf = rasterPixels;
      const published = publishPdfRaster(pdfKey, raster);
      useViewerStore.getState().updateAppearanceSource({ ...published,
        calibration: { sourcePoints: [[10, 20], [110, 20]], distanceMetres: 1 } });
      Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: class {
        constructor(readonly width: number, readonly height: number) { assert.equal(width, rasterPixels.width); assert.equal(height, rasterPixels.height); }
        getContext() { return { drawImage() {}, getImageData: () => ({ data: rasterPixels.rgba }) }; }
      } });
    } else {
      const asset = await appearanceAssets.add(png, { owner });
      useViewerStore.getState().addAppearanceSource({ id: asset.id, name: 'Texture', width: 1, height: 1 });
    }
    globalThis.createImageBitmap = async (blob: ImageBitmapSource) => {
      assert.ok(blob instanceof Blob); const bytes = new DataView(await blob.arrayBuffer());
      return { width: bytes.getUint32(16), height: bytes.getUint32(20), close() {} } as ImageBitmap;
    };
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NativeWorker });
    // The face-selection canvas has no GPU here. The main viewport hit below
    // carries the real owner/item/source-triangle contract into the editor.
    const init = mock.method(PreviewRenderer.prototype, 'init', async () => {});
    mock.method(PreviewRenderer.prototype, 'loadGeometry', () => {});
    mock.method(PreviewRenderer.prototype, 'render', () => {});
    mock.method(PreviewRenderer.prototype, 'fitToView', () => {});
    HTMLElement.prototype.setPointerCapture = () => {};
    const gpu = new AppearancePreviewController<number>({ capture: owner => ({ parts: resident.get(owner.expressId)!, resources: [] }),
      stage: () => [], install: (owner, parts) => { resident.set(owner.expressId, [...parts]); }, release() {} });
    // Instanced shards take their template in IFC Z-up; the scene converts.
    if (instanced) instanceScene = appearanceInstanceScene(originals, { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normals: new Float32Array(12).map((_, i) => i % 3 === 2 ? 1 : 0), indices });
    const activePreview = instanceScene?.preview ?? gpu;
    const readParts = (id: number) => instanceScene
      ? activePreview.getParts?.({ expressId: id, modelIndex: 0 }) ?? instanceScene.scene.getInstancedMeshDataPieces(id)
      : resident.get(id);
    const siblingBefore = meshSnapshot(readParts(globalId(35))!);
    const renderer = { getAppearancePreview: () => activePreview,
      getScene: () => instanceScene?.scene ?? { getMeshDataPieces: (id: number) => resident.get(id) }, requestRender() {},
      getGPUDevice: () => instanceScene?.device, getPipeline: () => instanceScene?.pipeline, getCanvas: () => null, clearCaches() {},
      getCamera: () => ({ fitBoundsAdaptive: () => ({ kind: 'compact' }), getPosition: () => ({ x: 0, y: 0, z: 0 }), getTarget: () => ({ x: 0, y: 0, z: 0 }), setSceneBounds() {}, setOrbitAnchorBounds() {}, reset() {} }) } as unknown as Renderer;
    setGlobalRendererRef({ current: renderer });
    const ui = render(<StrictMode>{instanced && <AppearanceStreamingHarness renderer={renderer} />}<AppearancePanel /><AuthorTab /></StrictMode>);
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await advance(10); assert.ok(predicate(), ui.textContent ?? 'UI stalled'); };
    const button = (name: string) => [...ui.querySelectorAll('button')].find(item => item.textContent?.trim() === name)!;
    const partIds = (parts: readonly MeshData[]) => parts.map(part => {
      if (part.geometryItemId === undefined) assert.fail('every appearance part must retain its geometry item identity');
      return part.geometryItemId;
    });
    const ids = (id: number) => partIds(readParts(id)!);
    const originalIds = pageSource ? [globalId(11), globalId(11)] : [globalId(11)];
    await until(() => requests.length > 0);
    const consent = ui.querySelector<HTMLInputElement>('input[type=checkbox]'); assert.ok(consent);
    await act(async () => consent.click());
    await until(() => !!button('Apply') && !button('Apply').disabled);
    const whole = requests.at(-1)!;
    assert.equal(whole.request.faceMasks, undefined);
    assert.equal(whole.plan.conversions?.length, 1); assert.equal(whole.plan.conversions![0].sourceIndices.length, 6);
    assert.match(ui.textContent ?? '', /all 2 faces/);
    const wholeTextured = globalId(whole.plan.conversions![0].geometryItemId);
    assert.deepEqual(ids(selection), pageSource ? [wholeTextured, wholeTextured] : [wholeTextured],
      'a whole-surface conversion textures every resident fragment without changing its partition');
    if (pageSource) assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
      'the initial whole-surface preview preserves both stream fragments');

    // Select one of the two faces: the plan carries the mask, the preview splits.
    await act(async () => button('Select faces').click());
    const editor = ui.querySelector(`[aria-label="Face selection for IFC object #25"]`); assert.ok(editor, 'the face editor opens for the converted object');
    const editorRenderers = init.mock.callCount();
    assert.ok(editorRenderers > 0, 'the face editor owns a renderer');
    await act(async () => button('Pick in model').click());
    await act(async () => { assert.equal(pickViewportAppearanceFace({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 },
      distance: 1, meshIndex: 0, triangleIndex: 0, expressId: selection, modelIndex: 0, geometryItemId: globalId(11),
      sourceTriangleIndex: 1, barycentricCoord: { u: 0.3, v: 0.3, w: 0.4 } }), 'picked'); });
    await until(() => requests.at(-1)!.request.faceMasks !== undefined && ui.textContent!.includes('Preview ready'));
    assert.equal(useViewerStore.getState().activeTool, 'appearance-face', 're-planning keeps main-view face pick active');
    assert.equal(init.mock.callCount(), editorRenderers, 'a face click and its re-plan keep the editor renderer and camera: the surface identity is stable');
    const masked = requests.at(-1)!;
    assert.deepEqual(masked.request.faceMasks, [{ productId: 25, surfaceFingerprint: whole.plan.conversions![0].surfaceFingerprint, triangles: [1] }]);
    assert.deepEqual(masked.plan.exclusions, []);
    const conversion = masked.plan.conversions![0];
    assert.equal(conversion.surfaceFingerprint, whole.plan.conversions![0].surfaceFingerprint);
    assert.deepEqual(conversion.maskedTriangles, [1]);
    if (pageSource) {
      assert.ok(masked.page && masked.rgba, 'the selected faces reached the native page compositor');
      assert.equal(masked.page.appearance.repeatS, false); assert.equal(masked.page.appearance.repeatT, false);
      assert.equal(masked.page.page.width * masked.page.page.height * 4, masked.rgba.length);
      assert.deepEqual([...masked.rgba], [...requireRasterPixels(decodedPdf).rgba],
        'native page planning receives the exact RGBA decoded by PDF.js');
      assert.deepEqual(masked.page.appearance.mapping, { kind: 'planar', frame: 'world', origin: [1, 0, 0],
        axisU: [0, 0, 1], axisV: [-1, -0, -0], metresPerTile: [0.72, 1] },
      'the known 100-unit PDF landmark span calibrates to exactly one metre');
      assert.equal(masked.page.texelsPerMetre, 50);
      const staleFingerprint = `${whole.plan.conversions![0].surfaceFingerprint![0] === '0' ? '1' : '0'}${whole.plan.conversions![0].surfaceFingerprint!.slice(1)}`;
      const stale = await import('@/workers/appearance.worker.js').then(module => module.runPageAppearancePlanning(source, {
        ...masked.page!, appearance: { ...masked.page!.appearance,
          faceMasks: [{ ...masked.page!.appearance.faceMasks![0], surfaceFingerprint: staleFingerprint }] },
      }, masked.rgba!));
      assert.equal(stale.plan.items.length, 0); assert.match(stale.plan.exclusions[0].reason, /Face selection is stale:.*geometry changed/);
      await assert.rejects(import('@/workers/appearance.worker.js').then(module => module.runPageAppearancePlanning(source,
        { ...masked.page!, texelsPerMetre: 1e9 }, masked.rgba!)), /budget/);
    }
    assert.ok(conversion.geometryItemId !== undefined && conversion.retainedGeometryItemId !== undefined);
    const textured = globalId(conversion.geometryItemId), retained = globalId(conversion.retainedGeometryItemId);
    const expectedSplitIds = [textured, retained].sort((a, b) => a - b);
    const splitIds = () => ids(selection).sort((a, b) => a - b);
    assert.deepEqual(splitIds(), expectedSplitIds, 'the masked preview stages the textured and the retained face set under one owner');
    const texturedPart = readParts(selection)!.find(part => part.geometryItemId === textured);
    const retainedPart = readParts(selection)!.find(part => part.geometryItemId === retained);
    assert.equal(texturedPart?.indices.length, 3); assert.equal(retainedPart?.indices.length, 3);
    assert.ok(texturedPart?.uvs && (texturedPart.textureRef || texturedPart.texture));
    assert.equal(retainedPart?.uvs, undefined);
    assert.deepEqual(retainedPart && [...retainedPart.color], [0.8, 0.2, 0.1, 1], 'the retained part keeps the source colour');
    if (pageSource) {
      assert.equal(texturedPart?.textureRef?.repeatS, false, 'finite PDF pages clamp instead of tile');
      assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
        'the masked preview preserves canonical source triangles across its textured/retained split');
      assertCanonicalFragments([texturedPart!], [[3, 4, 5]], 'the picked face keeps canonical source ordinal 1');
      assertCanonicalFragments([retainedPart!], [[0, 1, 2]], 'the unpicked face keeps canonical source ordinal 0');
    }
    assert.match(ui.textContent ?? '', /1 of 2 faces selected/);
    assert.deepEqual(meshSnapshot(readParts(globalId(35))!), siblingBefore,
      'preview leaves the sibling identity, geometry bytes, and style unchanged');
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
    assert.deepEqual(splitIds(), expectedSplitIds);
    assert.match(ui.textContent ?? '', /1 of 2 faces selected/);
    await act(async () => button('Compare original').click());
    assert.deepEqual(ids(selection), originalIds);
    if (pageSource) assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
      'Compare restores both original canonical fragments');
    await act(async () => button('Show preview').click());
    assert.deepEqual(splitIds(), expectedSplitIds);
    if (pageSource) assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
      'Show preview restores the canonical masked split');

    // Discard restores the single original part and keeps the selection for the next preview.
    await act(async () => button('Discard').click());
    await until(() => (ui.textContent ?? '').includes('Preview discarded'));
    assert.deepEqual(ids(selection), originalIds);
    if (pageSource) assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
      'Discard restores both original canonical fragments');
    const mappingInput = pageSource
      ? ui.querySelector<HTMLInputElement>('input[aria-label="Distance A–B (m)"]')
      : ui.querySelector<HTMLInputElement>('input[aria-label="Tile width (m)"]') ?? [...ui.querySelectorAll('label')].find(label => label.textContent?.includes('Tile width'))?.querySelector('input');
    assert.ok(mappingInput, 'a mapping field re-enables the preview');
    const planned = requests.length;
    type(mappingInput, '2');
    await until(() => requests.length > planned && !!button('Apply') && !button('Apply').disabled);
    const again = requests.at(-1)!;
    assert.deepEqual(again.request.faceMasks?.[0].triangles, [1], 'the selection survives Discard');
    assert.deepEqual(splitIds(), expectedSplitIds);
    if (pageSource) {
      assert.ok(again.page && again.result);
      assert.deepEqual(again.page.appearance.mapping, { kind: 'planar', frame: 'world', origin: [2, 0, 0],
        axisU: [0, 0, 1], axisV: [-1, -0, -0], metresPerTile: [1.44, 2] },
      'doubling the measured distance deterministically doubles the calibrated page scale');
      assert.equal(again.page.texelsPerMetre, 25, 'doubling page scale halves the raster density');
      assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
        'the re-preview keeps canonical provenance after calibration changes');
    }

    // Apply: one history step, two face sets in the IFC, the sibling untouched, selection intact.
    await act(async () => button('Apply').click());
    await until(() => (useViewerStore.getState().undoStacks.get('evaluated')?.length ?? 0) === 1);
    assert.equal(useViewerStore.getState().selectedEntityId, selection);
    assert.deepEqual(splitIds(), expectedSplitIds);
    const applied = useViewerStore.getState().models.get('evaluated')!.geometryResult!.meshes.filter(mesh => mesh.expressId === selection);
    assert.deepEqual(partIds(applied).sort((a, b) => a - b), expectedSplitIds,
      'the model geometry carries both parts of the product');
    if (pageSource) assertCanonicalFragments(applied, [[0, 1, 2], [3, 4, 5]],
      'Apply commits the same canonical source ordinals');
    assert.deepEqual(meshSnapshot(readParts(globalId(35))!), siblingBefore,
      'Apply leaves the sibling identity, geometry bytes, and style unchanged');
    assert.doesNotMatch(ui.textContent ?? '', /faces selected/, 'the applied selection is spent');
    const faceSets = view.getNewEntities().filter(entity => entity.type === 'IfcTriangulatedFaceSet').map(entity => entity.expressId);
    assert.deepEqual(faceSets, [conversion.geometryItemId, conversion.retainedGeometryItemId]);
    const serialized = prepareAppearanceSerialization('evaluated', data, view);
    const output = await new StepExporter(data, serialized.view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const text = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    assert.match(text, new RegExp(`#23=IFCSHAPEREPRESENTATION\\(#2,'Body','Tessellation',\\(#${faceSets[0]},#${faceSets[1]}\\)\\)`), 'the occurrence Body lists both face sets');
    assert.match(text, /#33=IFCSHAPEREPRESENTATION\(#2,'Body','MappedRepresentation',\(#22\)\)/, 'the sibling keeps its mapped Body');
    assert.equal((text.match(/IFCTRIANGULATEDFACESET\(/g) ?? []).length, 3, 'source quad plus textured and retained face sets');
    const registered = modelAppearanceAssets.exportResources('evaluated').resources;
    assert.equal(registered.size, 1, 'the applied command registers exactly one baked image');
    const expectedAsset = pageSource ? again.result?.assets[0] : undefined;
    if (pageSource) {
      assert.ok(expectedAsset && again.result?.assets.length === 1, 'native page planning bakes exactly one selected-face image');
      assert.deepEqual(again.result.itemImages, [{ geometryItemId: again.plan.conversions![0].geometryItemId,
        imageUri: expectedAsset.imageUri }], 'the sole native image is owned by the selected-face geometry item');
      assert.equal(registered.has(expectedAsset.imageUri), true, 'the registered resource retains the native image identity');
      assert.deepEqual(registered.get(expectedAsset.imageUri), expectedAsset.png,
        'the registered resource retains the exact native PNG bytes');
    }
    const archive = await unwrapIfcZipWithResources(new Uint8Array((await packagePortableIfcAsync('evaluated', text, serialized.resources)).content as Uint8Array).buffer);
    assert.equal(archive.originalResources.size, 1, 'the IFCZIP contains exactly one image resource');
    const derivative = [...archive.originalResources.values()][0];
    const derivativeUri = [...archive.originalResources.keys()][0];
    if (pageSource) {
      assert.equal(derivativeUri, expectedAsset!.imageUri, 'the archive keeps the native baked resource identity');
      assert.deepEqual(derivative, expectedAsset!.png, 'the archive keeps the exact registered native PNG bytes');
    }
    else assert.deepEqual(derivative, png);
    const reopened = await new IfcParser().parseColumnar(archive.model, { disableWorkerScan: true });
    assert.equal(reopened.entities.getGlobalId(25), '0Proxy000000000000000a');
    assert.ok(reopened.entityIndex.byId.has(faceSets[0]) && reopened.entityIndex.byId.has(faceSets[1]));
    if (pageSource) {
      const processor = new GeometryProcessor();
      try {
        await processor.init();
        const meshes = (await processor.process(new Uint8Array(archive.model))).meshes.filter(mesh => mesh.expressId === 25);
        const texturedMesh = meshes.find(mesh => mesh.geometryItemId === conversion.geometryItemId);
        const retainedMesh = meshes.find(mesh => mesh.geometryItemId === conversion.retainedGeometryItemId);
        assert.ok(texturedMesh?.uvs && texturedMesh.textureRef?.url === derivativeUri,
          'reopen preserves the selected-face UV/image association and selectable product identity');
        assert.equal(texturedMesh.textureRef.repeatS, false); assert.equal(texturedMesh.textureRef.repeatT, false);
        assert.equal(texturedMesh.expressId, 25); assert.equal(retainedMesh?.expressId, 25);
        assert.equal(retainedMesh?.textureRef, undefined); assert.ok(retainedMesh);
        [0.8, 0.2, 0.1, 1].forEach((expected, index) => assert.ok(Math.abs(retainedMesh.color[index] - expected) <= 1 / 255,
          'the retained face keeps the original style through IFC colour quantization'));
      } finally { processor.dispose(); }
    }

    // Undo joins the parts back into the original; Redo splits them again.
    await act(async () => { const undo = ui.querySelector<HTMLButtonElement>('button[aria-label="Undo"]'); assert.ok(undo && !undo.disabled); undo.click(); });
    assert.equal(view.getNewEntities().length, 0);
    assert.deepEqual(ids(selection), originalIds);
    if (pageSource) assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
      'Undo restores the original canonical fragments');
    if (instanced) assert.equal(useViewerStore.getState().models.get('evaluated')!.geometryResult!.meshes.length, 0);
    await act(async () => { const redo = ui.querySelector<HTMLButtonElement>('button[aria-label="Redo"]'); assert.ok(redo && !redo.disabled); redo.click(); });
    assert.deepEqual(splitIds(), expectedSplitIds);
    if (pageSource) assertCanonicalFragments(readParts(selection)!, [[0, 1, 2], [3, 4, 5]],
      'Redo restores the canonical masked split');
    assert.equal(view.getNewEntities().filter(entity => entity.type === 'IfcTriangulatedFaceSet').length, 2);
    assert.deepEqual(meshSnapshot(readParts(globalId(35))!), siblingBefore,
      'Redo leaves the sibling identity, geometry bytes, and style unchanged');
  } finally {
    cleanup(); instanceScene?.scene.clear(); setGlobalRendererRef({ current: previousRenderer });
    mock.restoreAll(); HTMLElement.prototype.setPointerCapture = capture;
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor); else Reflect.deleteProperty(globalThis, 'Worker');
    globalThis.createImageBitmap = oldDecode;
    if (canvasDescriptor) Object.defineProperty(globalThis, 'OffscreenCanvas', canvasDescriptor); else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
    if (pdfKey) removePdfDocument(pdfKey);
    useViewerStore.getState().clearAllMutations(); modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
    useViewerStore.setState(initial);
    modelIndices(new Map());
  }
});
