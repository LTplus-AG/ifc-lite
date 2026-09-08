/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rAF loop must outlive a throwing render() (#2229).
 *
 * `requestAnimationFrame(animate)` sits in TAIL position of `animate`, so any
 * throw before it means the loop is never re-armed: no further frame ever
 * runs, and the viewer freezes for the rest of the session with no message.
 * That is exactly what Safari's synchronous device-loss throw did in the
 * field. `Renderer.render()` now contains its own failures, but this loop is
 * the belt: it must survive a render-path throw even from a renderer that
 * does not contain one (an older/other Renderer build, or a future unguarded
 * path).
 *
 * The loop is driven by a hand-rolled rAF so frames step deterministically.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import { useAnimationLoop, type UseAnimationLoopParams } from './useAnimationLoop.js';

/**
 * Verbatim Safari 26.5 wording from the #2229 PostHog frames.
 *
 * Thrown here as a plain `Error`, deliberately: this file drives a STUB
 * renderer to prove the loop's own guard survives ANY throw out of `render()`.
 * The real `Renderer` discriminates on the exception type (only a DOMException
 * latches `deviceLost` — see renderer-device-loss-latch.test.ts); the loop must
 * not, since it cannot know which class it is holding.
 */
const SAFARI_LOST = 'InvalidStateError: The object is in an invalid state.';

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
  renderThrows: boolean;
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
}

function fakeRenderer(state: FakeRendererState): Renderer {
  const camera = {
    update: () => false,
    getRotation: () => ({ azimuth: 0, elevation: 0 }),
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getDistance: () => 10,
  };
  const scene = {
    hasQueuedMeshes: () => false,
    hasResidencyRestoreWork: () => false,
  };
  return {
    getCamera: () => camera,
    getScene: () => scene,
    getGPUDevice: () => ({}),
    getPipeline: () => ({}),
    peekRenderRequest: () => state.renderRequested,
    consumeRenderRequest: () => { state.renderRequested = false; },
    requestRender: () => { state.renderRequested = true; },
    clearCaches: () => {},
    getModelBounds: () => null,
    render: () => {
      state.renderCalls++;
      if (state.renderThrows) throw new Error(SAFARI_LOST);
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

describe('useAnimationLoop — a throwing render() must not kill the loop (#2229)', () => {
  it('keeps stepping frames after render() throws', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderThrows: true, renderRequested: true };
    await mount(baseParams(fakeRenderer(state)));

    // Frame 1 throws. Without the guard, the tail requestAnimationFrame never
    // runs and every later step() finds an empty queue — a frozen viewer.
    //
    // The property is that the loop stays ARMED, which is what the freeze was.
    // It is deliberately not "renderCalls keeps climbing": with the dirty flag
    // modelled honestly, a loop that is perfectly healthy still renders only
    // when something asks it to, so a render count here would measure the
    // re-request policy rather than the anti-freeze guarantee.
    for (let i = 0; i < 5; i++) {
      step();
      assert.ok(queued.length > 0, 'a frame must still be armed after every step');
    }

    assert.ok(state.renderCalls >= 1, 'the throwing frame must actually have been reached');
  });

  it('re-requests a frame, so a throw does not strand an idle viewer', async () => {
    // The loop CONSUMES the dirty flag before calling render(), so a frame that
    // throws has already spent its request. On an idle viewer nothing else
    // re-dirties it — no animation, no streaming, no interaction — so without a
    // re-request the failed frame is the last one ever drawn, and the viewer is
    // stale until the user happens to touch something. Surviving the throw is
    // only half of not freezing.
    const state: FakeRendererState = { renderCalls: 0, renderThrows: true, renderRequested: true };
    await mount(baseParams(fakeRenderer(state)));

    step();
    assert.equal(state.renderCalls, 1, 'precondition: frame 1 rendered and threw');
    assert.ok(
      state.renderRequested,
      'the failed frame must leave a render requested, or the viewport is stranded on a stale frame',
    );
  });

  it('warns once per session, not once per frame', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderThrows: true, renderRequested: true };
    await mount(baseParams(fakeRenderer(state)));

    // Keep the frame dirty from the outside every step, the way a user
    // orbiting the model would. That is what makes render() run — and keep
    // throwing — on all 30 frames; the loop's own one-shot re-request cannot
    // and must not sustain that on its own.
    for (let i = 0; i < 30; i++) {
      state.renderRequested = true;
      step();
    }

    assert.equal(state.renderCalls, 30);
    const renderWarnings = warnings.filter((w) => String(w[0]).includes('render() threw'));
    assert.equal(renderWarnings.length, 1, 'a dead device throws every frame; one warning is enough');
  });

  it('resumes normally once render() stops throwing', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderThrows: true, renderRequested: true };
    await mount(baseParams(fakeRenderer(state)));

    step();
    assert.equal(state.renderCalls, 1);
    state.renderThrows = false;

    // No external dirtying here on purpose: recovery must come from the loop's
    // own re-request after the failure, not from the test propping the flag up.
    step();
    assert.equal(
      state.renderCalls,
      2,
      'the frame after a failure must actually render — recovery has to restore the consumed request',
    );

    // And once it succeeds the loop settles instead of spinning: nothing is
    // dirty any more, so no further frame renders.
    step();
    step();
    assert.equal(state.renderCalls, 2, 'a recovered loop goes idle, it does not self-perpetuate');
  });

  it('still stops on unmount (the guard must not outlive the effect)', async () => {
    const state: FakeRendererState = { renderCalls: 0, renderThrows: true, renderRequested: true };
    await mount(baseParams(fakeRenderer(state)));
    step();
    const callsAtUnmount = state.renderCalls;

    for (const m of mounted.splice(0)) {
      await act(async () => { m.root.unmount(); });
      m.container.remove();
    }
    step();
    step();

    assert.equal(state.renderCalls, callsAtUnmount, 'no frames after unmount');
  });
});
