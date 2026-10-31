/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loop must not out-run the GPU (#5865).
 *
 * `queue.submit()` returns at once, so a slow GPU (software WebGPU) used to
 * collect a frame per rAF without bound, and the first pick after an orbit
 * waited seconds behind them. The loop now holds a frame back while
 * GPU_FRAMES_IN_FLIGHT submitted frames are outstanding, keeps the dirty flag,
 * and renders the newest state as soon as the GPU reports one finished.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer, RenderOptions } from '@ifc-lite/renderer';
import { useAnimationLoop, type UseAnimationLoopParams } from './useAnimationLoop.js';
import { GPU_FRAMES_IN_FLIGHT, GPU_FRAME_STALE_MS } from './gpuFramePacer.js';

// ---- deterministic rAF -----------------------------------------------------

let queued: FrameRequestCallback[] = [];
let now = 0;
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;

/** Run exactly one frame: drain what is queued now, at a fresh timestamp. */
function step(): void {
  const due = queued;
  queued = [];
  now += 16;
  for (const cb of due) cb(now);
}

// ---- fakes -----------------------------------------------------------------

interface FakeRendererState {
  renderCalls: number;
  /** throw out of render(), the way an uncontained device loss does */
  /** settles the frames' GPU completion promises, oldest first */
  gpuDone: Array<() => void>;
  gpuFail: Array<(reason: unknown) => void>;
  device?: object;
  deviceLost?: boolean;
  completionThrows?: boolean;
  /**
   * The renderer's dirty flag, modelled as the real one behaves: CONSUMABLE.
   *
   * This used to be a fixed `peekRenderRequest: () => true`, which made the
   * loop render unconditionally and quietly turned the recovery test below into
   * a test that could not fail — the loop is only asked for a frame when
   * something dirtied it, and the real loop consumes the flag BEFORE calling
   * render(), so a frame that throws spends the request on the way in.
   */
  renderRequested: boolean;
  animating?: boolean;
  frames?: RenderOptions[];
  /** the renderer skipped the frame (device lost, contained failure): nothing reached the queue */
  skipsFrames?: boolean;
}

function fakeRenderer(state: FakeRendererState): Renderer {
  state.device ??= {
    queue: {
      onSubmittedWorkDone: () => {
        if (state.completionThrows) throw new Error('device destroyed');
        return new Promise<void>((resolve, reject) => { state.gpuDone.push(resolve); state.gpuFail.push(reject); });
      },
    },
  };
  const camera = {
    update: () => state.animating ?? false,
    getRotation: () => ({ azimuth: 0, elevation: 0 }),
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getDistance: () => 10,
  };
  const scene = {
    hasQueuedMeshes: () => false,
    hasResidencyRestoreWork: () => false,
    getColorOverrides: () => null,
  };
  return {
    getCamera: () => camera,
    getScene: () => scene,
    getGPUDevice: () => (state.deviceLost ? null : state.device),
    getPipeline: () => ({}),
    peekRenderRequest: () => state.renderRequested,
    consumeRenderRequest: () => { state.renderRequested = false; },
    requestRender: () => { state.renderRequested = true; },
    clearCaches: () => {},
    getModelBounds: () => null,
    renderWithResult: (options: RenderOptions) => {
      state.frames?.push(options);
      state.renderCalls++;
      if (state.skipsFrames) return false;
      // A submitted frame owes the page a completion, as the real queue.submit does.
      return true;
    },
  } as unknown as Renderer;
}

function ref<T>(current: T) { return { current }; }

function baseParams(renderer: Renderer): UseAnimationLoopParams {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  return {
    canvasRef: ref<HTMLCanvasElement | null>(canvas),
    rendererRef: ref<Renderer | null>(renderer),
    isInitialized: true,
    animationFrameRef: ref<number | null>(null),
    lastFrameTimeRef: ref(0),
    mouseIsDraggingRef: ref(false),
    activeToolRef: ref('select'),
    terrainClipYRef: ref<number | null>(null),
    hiddenEntitiesRef: ref(new Set<number>()),
    isolatedEntitiesRef: ref<Set<number> | null>(null),
    ghostExceptEntitiesRef: ref<Set<number> | null>(null),
    selectedEntityIdRef: ref<number | null>(null),
    selectedModelIndexRef: ref<number | undefined>(undefined),
    clearColorRef: ref<[number, number, number, number]>([1, 1, 1, 1]),
    visualEnhancementRef: ref({ enabled: false }),
    environmentRef: ref({}),
    sunShadowsRef: ref(null),
    sectionPlaneRef: ref({ axis: 'y', position: 0, enabled: false, flipped: false }),
    sectionRangeRef: ref<{ min: number; max: number } | null>(null),
    selectedEntityIdsRef: ref<Set<number> | undefined>(undefined),
    clashHighlightColorsRef: ref<Map<number, [number, number, number, number]> | null>(null),
    coordinateInfoRef: ref(undefined),
    isInteractingRef: ref(false),
    lastCameraStateRef: ref(null),
    updateCameraRotationRealtime: () => {},
    calculateScale: () => {},
    updateMeasurementScreenCoords: () => {},
    hasPendingMeasurements: () => false,
  } as unknown as UseAnimationLoopParams;
}

function Harness({ params }: { params: UseAnimationLoopParams }) {
  const rendererRef = useRef(params.rendererRef.current);
  useAnimationLoop({ ...params, rendererRef });
  return null;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let warnings: unknown[][] = [];
const realWarn = console.warn;

beforeEach(() => {
  queued = [];
  now = 0;
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb);
    return queued.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => { queued = []; }) as typeof globalThis.cancelAnimationFrame;
});

afterEach(async () => {
  console.warn = realWarn;
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  for (const m of mounted.splice(0)) {
    await act(async () => { m.root.unmount(); });
    m.container.remove();
  }
});

async function mount(params: UseAnimationLoopParams): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => { root.render(<Harness params={params} />); });
}

describe('useAnimationLoop — GPU frame backlog (#5865)', () => {
  it('stops submitting at the allowed depth and resumes when the GPU catches up', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [] };
    await mount(baseParams(fakeRenderer(state)));

    // An orbit/inertia that keeps the camera animating: the loop wants a frame every rAF.
    for (let i = 0; i < 20; i++) step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT, 'a GPU that never finishes is never handed more than the allowed depth');
    assert.ok(queued.length > 0, 'the loop stays armed while it holds frames back');

    state.gpuDone.shift()!();
    await act(async () => { await Promise.resolve(); });
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 1, 'one finished frame frees exactly one slot');
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 1, 'and the loop is held back again');
  });

  it('keeps a requested render for the first free slot instead of dropping it', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderRequested: true, gpuDone: [], gpuFail: [] };
    await mount(baseParams(fakeRenderer(state)));
    for (let i = 0; i < GPU_FRAMES_IN_FLIGHT; i++) { state.renderRequested = true; step(); }
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT);

    state.renderRequested = true; // e.g. a selection changed while the GPU is behind
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT, 'held back');
    assert.equal(state.renderRequested, true, 'the request survives the held-back frame');

    state.gpuDone.shift()!();
    await act(async () => { await Promise.resolve(); });
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 1, 'rendered at the first free slot');
  });

  it('renders every requested frame while the GPU keeps up', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [] };
    await mount(baseParams(fakeRenderer(state)));
    for (let i = 0; i < 10; i++) {
      step();
      state.gpuDone.splice(0).forEach((done) => done()); // the GPU finishes each frame before the next rAF
      await act(async () => { await Promise.resolve(); });
    }
    assert.equal(state.renderCalls, 10);
  });
  it('survives a queue that throws on onSubmittedWorkDone() (device died after encode)', async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [], completionThrows: true };
      await mount(baseParams(fakeRenderer(state)));
      for (let i = 0; i < 10; i++) {
        step();
        assert.ok(queued.length > 0, 'a throw must not skip the tail requestAnimationFrame');
      }
      assert.equal(state.renderCalls, 10, 'unpaced frames keep rendering');
    } finally { console.warn = realWarn; }
  });

  it('frees the loop when the GPU reports the outstanding frames as failed (device loss)', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [] };
    await mount(baseParams(fakeRenderer(state)));
    for (let i = 0; i < 10; i++) step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT);
    state.gpuFail.splice(0).forEach((fail) => fail(new Error('device lost')));
    await act(async () => { await Promise.resolve(); });
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 1);
  });

  it('does not count a frame the renderer skipped as one the GPU owes', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [], skipsFrames: true };
    await mount(baseParams(fakeRenderer(state)));
    for (let i = 0; i < 10; i++) step();
    assert.equal(state.renderCalls, 10, 'a skipped frame never saturates the pacer, so the loop keeps being offered frames');
    assert.equal(state.gpuDone.length, 0, 'and no completion was requested for a frame that was never submitted');
  });

  it('refills one window per expiry when completions never settle: about 0.6 fps by design, queue stays bounded (hidden tab, lost device)', async () => {
    // rAF does not run in a hidden tab, so nothing is submitted meanwhile; what
    // is outstanding on return is either settled by then or expires.
    const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [] };
    let nowMs = 1000;
    const clock = mock.method(performance, 'now', () => nowMs);
    try {
      await mount(baseParams(fakeRenderer(state)));
      for (let i = 0; i < 10; i++) step();
      assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT, 'held back while the completions are pending');
      nowMs += GPU_FRAME_STALE_MS - 1;
      step();
      assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT, 'still held back just inside the expiry');
      nowMs += 2;
      step();
      assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 1, 'rendering resumes once the expiry has passed');
    } finally { clock.mock.restore(); }
  });

  it('does not hold the loop back while the device is lost, and forgets its frames after recovery', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderRequested: false, animating: true, gpuDone: [], gpuFail: [] };
    await mount(baseParams(fakeRenderer(state)));
    for (let i = 0; i < 10; i++) step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT);
    state.deviceLost = true; // getGPUDevice() is null while lost
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 1, 'the renderer, not the pacer, decides what a lost device does');
    state.deviceLost = false;
    state.device = { queue: { onSubmittedWorkDone: () => new Promise<void>(() => undefined) } }; // recovered: a new device
    step();
    assert.equal(state.renderCalls, GPU_FRAMES_IN_FLIGHT + 2, 'the old device\'s unfinished frames are not owed by the new one');
  });
});
