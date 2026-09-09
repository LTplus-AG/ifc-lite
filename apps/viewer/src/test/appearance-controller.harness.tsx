/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { AppearancePreviewController } from '../../../../packages/renderer/src/appearance-preview.js';
import { AppearancePanel } from '@/components/viewer/appearance/AppearancePanel.js';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef, getGlobalRenderer } from '@/hooks/useBCF';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client.js';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse, AppearancePlan } from '@/lib/appearance/planner-types.js';
import { fixtureModel } from './store-fixture.js';

export const controllerPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const MODEL = 'strict-appearance';
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Appearance controller regression: ${message}`);
}
async function advance(ms = 20): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await advance();
  check(predicate(), message);
}

/** Controlled transport, with the production planner client managing its lifetime. */
class ControlledWorker implements AppearanceWorker {
  onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  message?: Extract<AppearanceWorkerRequest, { type: 'plan' }>;
  lateMessage: ControlledWorker['onmessage'] = null;
  terminations = 0;
  postMessage(message: AppearanceWorkerRequest) {
    if (message.type === 'catalog') {
      // Metadata is supplied through the worker boundary, independently from
      // the controller. Parse its actual effective IFC bytes for this fixture.
      void new IfcParser().parseColumnar(new Uint8Array(message.source).buffer, { disableWorkerScan: true }).then(store => {
        this.onmessage?.(new MessageEvent<AppearanceWorkerResponse>('message', { data: { type: 'catalog-complete', id: message.id, catalog: {
          sourceRevision: message.request.sourceRevision,
          products: message.request.productIds.map(productId => ({ productId,
            ifcClass: store.entities.getTypeName(productId), typeIds: [] })),
          types: [], missingProductIds: [],
        } } }));
      }).catch(error => this.onerror?.({ message: String(error) } as ErrorEvent));
      return;
    }
    if (message.type === 'page-plan' || message.type === 'annotation-plan') throw new Error('Image-only controller fixture received a page plan');
    this.message = structuredClone(message);
    this.lateMessage = this.onmessage;
  }
  terminate() { this.terminations++; }
  complete(late = false): void {
    const message = this.message;
    check(message, 'worker did not receive a request');
    const next = message.request.nextExpressId;
    const plan: AppearancePlan = {
      sourceRevision: message.request.sourceRevision, nextExpressId: next, nextAvailableExpressId: next + 6,
      created: [
        { expressId: next, type: 'IfcImageTexture', attributes: [true, true, 'DIFFUSE', null, null, message.request.imageUri] },
        { expressId: next + 1, type: 'IfcTextureVertexList', attributes: [[[0, 0], [1, 0], [0, 1]]] },
        { expressId: next + 2, type: 'IfcIndexedTriangleTextureMap', attributes: [[`#${next}`], '#11', `#${next + 1}`, [[1, 2, 3]]] },
        { expressId: next + 3, type: 'IfcSurfaceStyleWithTextures', attributes: [[`#${next}`]] },
        { expressId: next + 4, type: 'IfcSurfaceStyle', attributes: [null, '.BOTH.', [`#${next + 3}`]] },
        { expressId: next + 5, type: 'IfcStyledItem', attributes: ['#11', [`#${next + 4}`], null] },
      ], edits: [], removed: [], exclusions: [], items: [{ productId: 25, geometryItemId: 11,
        texCoords: [[0, 0], [1, 0], [0, 1]], texCoordIndex: [[1, 2, 3]], sourceIndices: [0, 1, 2],
        targetIndices: [0, 1, 2], previewCornerUvs: [0, 0, 1, 0, 0, 1],
        targetVertexCount: 3, targetCornerNormals: [0, 0, 1, 0, 0, 1, 0, 0, 1] }],
    };
    (late ? this.lateMessage : this.onmessage)?.({ data: { type: 'complete', id: message.id, plan } } as MessageEvent<AppearanceWorkerResponse>);
  }
}

/** Shared by Node/HappyDOM and an isolated real-browser lab; never run in a user's model session. */
export async function runAppearanceControllerScenario(
  scenario: 'strict-source' | 'discard-debounce' | 'discard-worker' | 'stale-version' | 'upload-failure',
  imageBytes = controllerPng,
): Promise<{ scenario: string; requests: number; terminations: number; stages: number; nativeBitmaps: number }> {
  const initial = useViewerStore.getState();
  const oldRenderer = getGlobalRenderer();
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const workers: ControlledWorker[] = [];
  const allWorkers: ControlledWorker[] = [];
  let root: Root | undefined;
  const container = document.createElement('div');
  document.body.append(container);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true,
    value: class extends ControlledWorker {
      constructor() { super(); allWorkers.push(this); }
      override postMessage(message: AppearanceWorkerRequest) {
        if (message.type === 'plan') workers.push(this);
        super.postMessage(message);
      }
    } });
  let stages = 0, nativeBitmaps = 0;
  try {
    const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Mounted appearance controller'),'2;1');
FILE_NAME('controller.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#6),#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#23=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#11));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Original',$,$,$,#24,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`);
    const data = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(data.properties, MODEL);
    const editor = new StoreEditor(data, view);
    const indices = new Uint32Array([0, 1, 2]);
    const mesh: MeshData = { expressId: 25, geometryItemId: 11, modelIndex: 0,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices, color: [0.8, 0.8, 0.8, 1], appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
    const geometry: GeometryResult = { meshes: [mesh], totalTriangles: 1, totalVertices: 3,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
    const model = { ...fixtureModel(MODEL), ifcDataStore: data, geometryResult: geometry,
      maxExpressId: 25, loadedAt: 1, schemaVersion: 'IFC4' as const, loadState: 'complete' as const };
    useViewerStore.setState({ models: new Map([[MODEL, model]]), activeModelId: MODEL, geometryResult: geometry,
      mutationViews: new Map([[MODEL, view]]), storeEditors: new Map([[MODEL, editor]]),
      undoStacks: new Map(), redoStacks: new Map(), mutationVersion: 0, collabRoomId: null,
      appearanceSources: [], appearanceDraft: null, selectedEntityId: null, selectedEntityIds: new Set() });
    useViewerStore.getState().setAttribute(MODEL, 25, 'Name', 'Edited before preview');
    const graph = () => {
      const content = new StepExporter(data, view).export({ schema: 'IFC4', applyMutations: true }).content;
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      // FILE_NAME carries export time; compare the effective entity graph.
      return text.slice(text.indexOf('DATA;'));
    };
    const originalGraph = graph();
    const originalHistory = JSON.stringify(view.getMutations());
    let parts: readonly MeshData[] = [mesh];
    const gpu = new AppearancePreviewController<number>({
      capture: () => ({ parts, resources: [0] }),
      stage: next => { stages++; nativeBitmaps += next.filter(part => typeof ImageBitmap !== 'undefined' && part.textureBitmap instanceof ImageBitmap).length; return [stages]; },
      install: (_owner, next) => { parts = next; }, release: () => {},
    });
    const renderer = { getAppearancePreview: () => gpu,
      getScene: () => ({ getMeshDataPieces: () => parts }), requestRender() {},
    } as unknown as Renderer;
    setGlobalRendererRef({ current: renderer });
    const mount = async () => {
      root = createRoot(container);
      await act(async () => { root!.render(<StrictMode><AppearancePanel /></StrictMode>); });
    };
    const unmount = async () => { await act(async () => { root?.unmount(); root = undefined; }); };
    const button = (label: string) => {
      const target = [...container.querySelectorAll('button')].find(element => element.textContent?.trim() === label);
      check(target, `${label} button missing`); return target;
    };
    const click = async (label: string) => { await act(async () => { button(label).click(); }); };
    await mount();
    const picker = container.querySelector<HTMLInputElement>('input[type=file]');
    check(picker, 'upload input missing');
    const file = new window.File([new Uint8Array(imageBytes)], 'Strict source.png', { type: 'image/png' });
    const transfer = new window.DataTransfer(); transfer.items.add(file);
    Object.defineProperty(picker, 'files', { configurable: true, value: transfer.files });
    await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await until(() => useViewerStore.getState().appearanceSources.length === 1, 'source upload never reached the catalog');
    const sourceId = useViewerStore.getState().appearanceSources[0].id;
    check(appearanceAssets.get(sourceId), 'uploaded source was released');
    if (scenario === 'strict-source') {
      const mapping = container.querySelector<HTMLSelectElement>('select[aria-label="Texture mapping"]');
      check(mapping && !mapping.disabled, 'mapping select unavailable after upload');
      await act(async () => {
        mapping.value = 'box';
        mapping.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    }

    if (scenario === 'discard-debounce') {
      await click('Discard');
      await advance(350);
      check(workers.length === 0, 'Discard during debounce still started a worker');
    } else {
      await until(() => !!workers[0]?.message, `upload never reached worker: ${container.textContent}`);
      const request = workers[0].message!;
      const exported = await new IfcParser().parseColumnar(new Uint8Array(request.source).buffer, { disableWorkerScan: true });
      check(exported.entities.getName(25) === 'Edited before preview', 'worker did not receive effective IFC overlay');
      check(exported.entityIndex.byType.get('IFCTRIANGULATEDFACESET')?.includes(11), 'worker source omitted canonical surface geometry');
      check(request.request.productIds.length === 1 && request.request.productIds[0] === 25, 'worker scope lost source IFC identity');
      check(request.request.imageUri === appearanceAssets.get(sourceId)?.exportName, 'worker image URI differs from retained encoded image');
      if (scenario === 'upload-failure') {
        const invalid = new window.DataTransfer();
        invalid.items.add(new window.File([new Uint8Array([0, 1, 2])], 'broken.png', { type: 'image/png' }));
        Object.defineProperty(picker, 'files', { configurable: true, value: invalid.files });
        await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
        await until(() => !!container.querySelector('[role=alert]')?.textContent, 'invalid image upload did not report failure');
        const failure = container.querySelector('[role=alert]')!.textContent;
        check(workers[0].terminations === 1, 'upload failure did not cancel the older preview job');
        await act(async () => { workers[0].complete(true); });
        await advance(300);
        check(container.querySelector('[role=alert]')?.textContent === failure, 'older preview completion hid the upload failure');
        check(stages === 0, 'older preview installed after a failed source change');
      } else if (scenario === 'discard-worker') {
        await click('Discard');
        check(workers[0].terminations === 1, 'Discard did not terminate pending worker');
        await act(async () => { workers[0].complete(true); });
        await advance(300);
        check(stages === 0, 'late cancelled worker response installed a preview');
      } else {
        await act(async () => { workers[0].complete(); });
        await until(() => !button('Apply').disabled, `preview never became ready: ${container.textContent}`);
        check(parts[0].textureBitmap?.width, 'real inventory decode did not reach the preview');
        if (scenario === 'stale-version') {
          await act(async () => { useViewerStore.getState().bumpMutationVersion(); });
          check(button('Apply').disabled, 'stale revision left Apply enabled');
          await click('Apply');
          await click('Discard');
        } else {
          await unmount();
          check(appearanceAssets.get(sourceId), 'closing the panel released its catalog source');
          check(useViewerStore.getState().appearanceSources[0]?.id === sourceId, 'closing the panel removed catalog metadata');
          await mount();
          await until(() => !!workers[1]?.message, 'StrictMode reopen reused a disposed planner or lost image ownership');
          check(workers[1].message?.request.mapping.kind === 'box', 'reopened draft lost its chosen mapping in the actual planner request');
          await click('Discard');
          check(workers[1].terminations === 1, 'reopened panel did not cancel its worker');
          await unmount();
          await mount();
          await advance(350);
          check(workers.length === 2, 'reopening a discarded draft restarted its worker');
        }
      }
    }
    check(graph() === originalGraph, 'preview/cancellation changed exported IFC');
    check(JSON.stringify(view.getMutations()) === originalHistory, 'preview/cancellation recorded IFC edits');
    check(parts[0].textureBitmap === undefined, 'cancelled preview still owns renderer appearance');
    await unmount();
    const retained = appearanceAssets.encoded(sourceId);
    check(retained.length === imageBytes.length && retained.every((byte, index) => byte === imageBytes[index]), 'panel close lost original image bytes');
    useViewerStore.getState().removeAppearanceSource(sourceId);
    check(appearanceAssets.get(sourceId) === undefined, 'removing the final source leaked a draft lease');
    check(allWorkers.every(worker => worker.terminations === 1), 'catalog or preview worker leaked after unmount');
    return { scenario, requests: workers.length, terminations: workers.reduce((sum, worker) => sum + worker.terminations, 0), stages, nativeBitmaps };
  } finally {
    await act(async () => { root?.unmount(); });
    for (const worker of allWorkers) if (!worker.terminations) worker.terminate();
    container.remove();
    useViewerStore.getState().clearAllMutations();
    modelAppearanceAssets.clear(); appearanceAssets.clear();
    useViewerStore.setState(initial, true);
    setGlobalRendererRef({ current: oldRenderer });
    if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
}
