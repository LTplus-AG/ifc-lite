/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { StrictMode, act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { AppearancePreviewController } from '../../../../../../packages/renderer/src/appearance-preview.js';
import { render, cleanup, advance } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { texturedProductSource, texturedProductPng as png } from '@/test/textured-product-fixture.js';
import { useViewerStore } from '@/store';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import { prepareAppearanceSerialization } from '@/lib/appearance/serialization.js';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client.js';
import type { AppearancePlan, AppearanceCatalog, AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types.js';
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document.js';
import { registerPdfDocument, removePdfDocument } from '@/lib/appearance/pdf/documents.js';
import { publishPdfRaster } from '@/lib/appearance/pdf/publish-source.js';
import { controlledPdf } from '@/lib/appearance/pdf/fixtures.js';
import type { PdfRasterRecipe } from '@/lib/appearance/pdf/types.js';
import { runPageAppearancePlanning } from '@/workers/appearance.worker.js';
import { AppearancePanel } from './AppearancePanel.js';

// Two occurrence-owned Body wrappers share one mapped item and original style.
// The triangle coordinates are explicit: its rendered corners must never move.
const source = new TextEncoder().encode(new TextDecoder().decode(texturedProductSource).replace('ENDSEC;\nEND-ISO', `
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#12=IFCCOLOURRGB($,0.8,0.2,0.1);
#13=IFCSURFACESTYLERENDERING(#12,0.,$,$,$,$,$,$,.NOTDEFINED.);
#14=IFCSURFACESTYLE('Original',.BOTH.,(#13));
#15=IFCSTYLEDITEM(#11,(#14),$);
#17=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#11));
#20=IFCREPRESENTATIONMAP(#5,#17);
#21=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
#22=IFCMAPPEDITEM(#20,#21);
#23=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Chosen occurrence',$,$,#41,#24,$,.NOTDEFINED.);
#33=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#22));
#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000b',$,'Sibling occurrence',$,$,#41,#34,$,.NOTDEFINED.);
#54=IFCRELCONTAINEDINSPATIALSTRUCTURE('0hhhhhhhhhhhhhhhhhhhhh',$,$,$,(#25,#35),#40);
ENDSEC;\nEND-ISO`));
const wasmUrl = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);

for (const pageSource of [false, true]) for (const federated of [false, true]) test(`mounted native ${pageSource ? 'finite page' : 'image'} occurrence conversion preserves sibling and one Undo/Redo in ${federated ? 'federation' : 'one model'} (#4404)`, {
  skip: !existsSync(wasmUrl) && 'Run pnpm build:wasm for the native appearance contract',
}, async () => {
  const initial = useViewerStore.getState(), previousRenderer = getGlobalRenderer();
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const oldDecode = globalThis.createImageBitmap;
  const canvasDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  let pdfKey: string | undefined;
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const requests: AppearancePlan[] = [];
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
            requests.push(plan); response = { type: 'complete', id: job.id, plan };
          } else if (job.type === 'page-plan') {
            const result = await runPageAppearancePlanning(new Uint8Array(job.source), job.request, job.rgba);
            requests.push(result.plan); response = { type: 'page-complete', id: job.id, result };
          } else throw new Error('Unexpected native fixture request');
          this.onmessage?.({ data: response } as MessageEvent<AppearanceWorkerResponse>);
        } catch (error) { this.onerror?.({ message: String(error) } as ErrorEvent); }
        finally { api.free(); }
      });
    }
  }
  try {
    const data = await new IfcParser().parseColumnar(source.slice().buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(data.properties, 'evaluated');
    if (federated) federationRegistry.registerModel('other', 100);
    const idOffset = federationRegistry.registerModel('evaluated', 54);
    const globalId = (id: number) => federationRegistry.toGlobalId('evaluated', id);
    const indices = new Uint32Array([0, 1, 2]);
    const makeMesh = (id: number): MeshData => ({ expressId: globalId(id), geometryItemId: globalId(11), modelIndex: federated ? 1 : 0,
      positions: new Float32Array([0,0,0,1,0,0,0,0,-1]), normals: new Float32Array([0,1,0,0,1,0,0,1,0]), indices,
      color: [0.8,0.2,0.1,1], appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } });
    const originals = [makeMesh(25), makeMesh(35)];
    const resident = new Map(originals.map(mesh => [mesh.expressId, [mesh] as readonly MeshData[]]));
    const bounds = { min: { x: 0, y: 0, z: -1 }, max: { x: 1, y: 0, z: 0 } };
    const geometry: GeometryResult = { meshes: originals, totalTriangles: 2, totalVertices: 6,
      coordinateInfo: { originShift: { x: 0,y: 0,z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
    const model = { ...fixtureModel('evaluated'), idOffset, maxExpressId: 54, ifcDataStore: data, geometryResult: geometry, schemaVersion: 'IFC4' as const, loadState: 'complete' as const };
    const other = fixtureModel('other');
    const selection = globalId(25);
    useViewerStore.setState({ models: new Map([...(federated ? [['other',other] as const] : []), ['evaluated', model]]), activeModelId: 'evaluated',
      geometryResult: geometry, mutationViews: new Map([['evaluated',view]]), storeEditors: new Map([['evaluated',new StoreEditor(data,view)]]),
      undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), mutationVersion: 0, collabRoomId: null,
      appearanceSources: [], appearanceDraft: null, selectedEntityId: selection, selectedEntityIds: new Set([selection]) });
    const owner = { kind: 'source' as const, id: 'evaluated-image' };
    const asset = await appearanceAssets.add(png, { owner });
    if (pageSource) {
      const recipe: PdfRasterRecipe = { page: { pageNumber: 1, viewBox: [0,0,72,72], userUnit: 1, intrinsicRotation: 0,
        widthPoints: 72, heightPoints: 72, pdfToPage: [1,0,0,-1,0,72] }, rotation: 0, cropPoints: [0,0,72,72],
        requestedDpi: 1, effectiveDpi: 1, pixelWidth: 1, pixelHeight: 1, paperSizeMetres: [0.0254,0.0254], pixelToPdf: [72,0,0,-72,0,72] };
      // PDF decoding is covered by the engine/browser acceptance. Supply its
      // one-pixel derivative at that boundary; projection/IFC planning is real WASM.
      const document = await PdfAppearanceSource.open(new File([controlledPdf()], 'Page.pdf', { type: 'application/pdf' }), appearanceAssets, {
        worker: { async run(_bytes,job) { return job.kind === 'inspect' ? { kind: 'inspect', pageCount: 1, page: recipe.page } : { kind: 'raster', png, recipe }; }, cancel() {}, dispose() {} },
      });
      pdfKey = registerPdfDocument(document);
      const published = publishPdfRaster(pdfKey, await document.rasterize({ pageNumber: 1 }));
      useViewerStore.getState().updateAppearanceSource({ ...published, calibration: { sourcePoints: [[0,72],[72,72]], distanceMetres: 1 } });
      Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: class {
        constructor(readonly width: number, readonly height: number) {}
        getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([255,255,255,255]) }) }; }
      } });
    } else useViewerStore.getState().addAppearanceSource({ id: asset.id, name: 'Texture', width: 1, height: 1 });
    globalThis.createImageBitmap = async (blob: ImageBitmapSource) => {
      assert.ok(blob instanceof Blob); const bytes = new DataView(await blob.arrayBuffer());
      return { width: bytes.getUint32(16),height: bytes.getUint32(20),close() {} } as ImageBitmap;
    };
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NativeWorker });
    const gpu = new AppearancePreviewController<number>({ capture: owner => ({ parts: resident.get(owner.expressId)!, resources: [] }),
      stage: () => [], install: (owner, parts) => { resident.set(owner.expressId, parts); }, release() {} });
    const renderer = { getAppearancePreview: () => gpu, getScene: () => ({ getMeshDataPieces: (id: number) => resident.get(id) }), requestRender() {} } as unknown as Renderer;
    setGlobalRendererRef({ current: renderer });
    const ui = render(<StrictMode><AppearancePanel /></StrictMode>);
    const until = async (predicate: () => boolean) => { for (let i=0;i<200&&!predicate();i++) await advance(10); assert.ok(predicate(), ui.textContent ?? 'UI stalled'); };
    await until(() => requests.length > 0);
    assert.equal(requests[0].conversions?.length ?? 0, 0);
    assert.equal(view.getNewEntities().length, 0);
    const consent = ui.querySelector<HTMLInputElement>('input[type=checkbox]'); assert.ok(consent); assert.equal(consent.checked,false);
    await act(async () => consent.click());
    const button = (name: string) => [...ui.querySelectorAll('button')].find(item => item.textContent?.trim() === name)!;
    await until(() => !!button('Apply') && !button('Apply').disabled);
    assert.match(ui.textContent ?? '', /1 objects will become mesh geometry/);
    const plan = requests.at(-1)!; assert.equal(plan.conversions?.length,1);
    assert.equal(view.getNewEntities().length,0,'preview publishes no IFC conversion');
    assert.equal(resident.get(globalId(35))![0],originals[1]);
    await act(async () => button('Compare original').click());
    assert.equal(resident.get(selection)![0].geometryItemId,globalId(11));
    await act(async () => button('Show preview').click());
    assert.equal(resident.get(selection)![0].geometryItemId,globalId(plan.conversions![0].geometryItemId));
    await act(async () => button('Apply').click());
    await until(() => (useViewerStore.getState().undoStacks.get('evaluated')?.length ?? 0) === 1);
    assert.equal(useViewerStore.getState().selectedEntityId,selection);
    assert.equal(resident.get(selection)![0].geometryItemId,globalId(plan.conversions![0].geometryItemId));
    const serialized = prepareAppearanceSerialization('evaluated',data,view);
    const resourceMap = serialized.resources.exportResources().resources;
    const resources = [...resourceMap.values()];
    if (pageSource) { assert.ok(resources.length > 0); assert.equal(resident.get(selection)![0].textureRef?.repeatS,false);
      assert.ok(resourceMap.has(resident.get(selection)![0].textureRef!.url), 'the converted item binds its portable atlas'); }
    else assert.deepEqual(resources[0],png);
    const output = await new StepExporter(data,serialized.view).exportAsync({ schema: 'IFC4',applyMutations: true,includeGeometry: true });
    const text = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    assert.match(text,/#33=IFCSHAPEREPRESENTATION\(#2,'Body','MappedRepresentation',\(#22\)\)/);
    await act(async () => useViewerStore.getState().undo('evaluated'));
    assert.equal(view.getNewEntities().length,0);
    assert.equal(resident.get(selection)![0].geometryItemId,globalId(11));
    await act(async () => useViewerStore.getState().redo('evaluated'));
    assert.equal(resident.get(selection)![0].geometryItemId,globalId(plan.conversions![0].geometryItemId));
    assert.equal(resident.get(globalId(35))![0],originals[1]);
    if(federated) assert.equal(useViewerStore.getState().models.get('other'),other);
  } finally {
    cleanup(); setGlobalRendererRef({ current: previousRenderer });
    if(workerDescriptor) Object.defineProperty(globalThis,'Worker',workerDescriptor); else Reflect.deleteProperty(globalThis,'Worker');
    globalThis.createImageBitmap=oldDecode;
    if(canvasDescriptor) Object.defineProperty(globalThis,'OffscreenCanvas',canvasDescriptor); else Reflect.deleteProperty(globalThis,'OffscreenCanvas');
    if(pdfKey) removePdfDocument(pdfKey);
    useViewerStore.getState().clearAllMutations(); modelAppearanceAssets.clear(); appearanceAssets.clear(); federationRegistry.clear();
    useViewerStore.setState(initial);
  }
});
