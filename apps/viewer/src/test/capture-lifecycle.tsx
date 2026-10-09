/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Renderer, type RenderOptions } from '../../../../packages/renderer/src/index.js';
import { useAnimationLoop, type UseAnimationLoopParams } from '@/components/viewer/useAnimationLoop';
import { useBCF, clearGlobalRefs, setGlobalCanvasRef, setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';

export interface CaptureObservation {
  width: number;
  height: number;
  ghostIds: number[] | null;
  camera: { x: number; y: number; z: number };
}

const ref = <T,>(current: T) => ({ current });

/** Actual loop, renderer viewport/camera, BCF and screenshot paths; GPU/PNG boundaries only are controlled. */
export async function captureLifecycle(dpr: number) {
  const savedRaf = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  const savedDateNow = Date.now;
  const savedDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  let time = 0;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = callback => { callbacks.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = id => { callbacks.delete(id); };
  Date.now = () => 100_000 + time;
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
  const step = () => {
    time += 16;
    const due = [...callbacks];
    for (const [id, callback] of due) {
      if (!callbacks.delete(id)) continue;
      callback(time);
    }
  };
  let completeWork = () => {};
  let rejectWork = (_error: Error) => {};
  let work: Promise<void> = Promise.resolve();
  let waits = 0;
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
  const renderer = new Renderer(canvas);
  const deviceState = renderer['device'] as unknown as Record<string, unknown>;
  deviceState.device = {
    limits: { maxTextureDimension2D: 8192 },
    queue: { onSubmittedWorkDone: () => { waits++; return work; } },
  };
  // Real render() measures/resizes and sets camera aspect, then exits at ensureContext.
  // No GPU encoding or real PNG/image equivalence is claimed by this fixture.
  deviceState.context = {};
  const resizes: number[][] = [];
  (renderer as unknown as Record<string, unknown>).pipeline = {
    resize: (width: number, height: number) => { resizes.push([width, height]); },
  };
  let lastOptions: RenderOptions = {};
  const frames: RenderOptions[] = [];
  const originalRender = renderer.render.bind(renderer);
  renderer.render = options => { lastOptions = options ?? {}; frames.push(lastOptions); originalRender(options); };
  const captures: CaptureObservation[] = [];
  canvas.toDataURL = () => {
    const observation = {
      width: canvas.width, height: canvas.height,
      ghostIds: lastOptions.ghostExceptIds ? [...lastOptions.ghostExceptIds] : null,
      camera: { ...renderer.getCamera().getPosition() },
    };
    captures.push(observation);
    // A readback observation sentinel, deliberately not a fabricated physical GPU PNG.
    return 'data:image/png;base64,' + Buffer.from(JSON.stringify(observation)).toString('base64');
  };
  const params: UseAnimationLoopParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    animationFrameRef: ref(null), lastFrameTimeRef: ref(0), mouseIsDraggingRef: ref(false),
    activeToolRef: ref('select'), terrainClipYRef: ref(null), hiddenEntitiesRef: ref(new Set()),
    isolatedEntitiesRef: ref(null), ghostExceptEntitiesRef: ref(null), selectedEntityIdRef: ref(null),
    selectedModelIndexRef: ref(undefined), clearColorRef: ref([1, 1, 1, 1]),
    visualEnhancementRef: ref({ enabled: false }), environmentRef: ref({}), sunShadowsRef: ref(null),
    sectionPlaneRef: ref({ axis: 'y', position: 0, enabled: false, flipped: false }),
    sectionRangeRef: ref(null), selectedEntityIdsRef: ref(undefined), clashHighlightColorsRef: ref(null),
    coordinateInfoRef: ref(undefined), isInteractingRef: ref(false), lastCameraStateRef: ref(null),
    updateCameraRotationRealtime: () => {}, calculateScale: () => {},
    updateMeasurementScreenCoords: () => {}, hasPendingMeasurements: () => false,
  };
  let bcf: ReturnType<typeof useBCF> | undefined;
  function Probe() {
    useAnimationLoop(params);
    bcf = useBCF({ canvasRef: params.canvasRef, rendererRef: params.rendererRef });
    return null;
  }
  const savedStore = useViewerStore.getState();
  useViewerStore.setState({ models: new Map(), geometryResult: null, ifcDataStore: null,
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    selectedEntityId: null, selectedEntityIds: new Set(), clashHighlightColors: new Map() });
  setGlobalCanvasRef(params.canvasRef);
  setGlobalRendererRef(params.rendererRef);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  assert.ok(bcf);
  const api = bcf;
  let disposed = false;
  return {
    renderer, canvas, params, bcf: api, step, captures, resizes, frames,
    get waits() { return waits; },
    deferWork() { work = new Promise<void>((resolve, reject) => { completeWork = resolve; rejectWork = reject; }); },
    finishWork() { const resolve = completeWork; work = Promise.resolve(); resolve(); },
    failWork(error: Error) { const reject = rejectWork; work = Promise.resolve(); reject(error); },
    async flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await act(async () => root.unmount());
      container.remove(); clearGlobalRefs();
      useViewerStore.setState(savedStore, true);
      globalThis.requestAnimationFrame = savedRaf;
      globalThis.cancelAnimationFrame = savedCancel;
      Date.now = savedDateNow;
      if (savedDpr) Object.defineProperty(window, 'devicePixelRatio', savedDpr);
      else Reflect.deleteProperty(window, 'devicePixelRatio');
    },
  };
}
