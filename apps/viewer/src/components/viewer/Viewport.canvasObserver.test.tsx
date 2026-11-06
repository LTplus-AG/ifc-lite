/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9032: the mounted Viewport's canvas ResizeObserver ends Point mode's Live
 * on a resize that keeps the aspect (#8886) and re-renders on every report.
 * `viewportCanvasObserver.test.ts` proves the helper does this; this proves
 * the Viewport uses it, by mounting the real Viewport and its animation loop.
 * Only the GPU (`capture-gpu.ts`) and the browser's layout boundary (frames
 * and ResizeObserver reports) are controlled.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { cleanup, render } from '@/test/render.js';
import { installCaptureGpu } from '@/test/capture-gpu';
import { useViewerStore } from '@/store';
import { Viewport } from './Viewport.js';

interface Observation { callback: ResizeObserverCallback; observer: ResizeObserver; targets: Element[] }

let observations: Observation[] = [];
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let time = 0;
let renderer: Renderer | null = null;
/** Every controlled GPU installed, newest last: the renderer effect may run more than once. */
let gpus: Array<ReturnType<typeof installCaptureGpu>> = [];
const restore: Array<() => void> = [];

function swap<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => { if (saved) Object.defineProperty(target, key, saved); else Reflect.deleteProperty(target, key); });
}

beforeEach(() => {
  observations = []; frames = new Map(); nextFrame = 0; time = 0; renderer = null; gpus = [];
  class RecordingResizeObserver implements ResizeObserver {
    readonly #observation: Observation;
    constructor(callback: ResizeObserverCallback) {
      this.#observation = { callback, observer: this, targets: [] };
      observations.push(this.#observation);
    }
    observe(target: Element): void { this.#observation.targets.push(target); }
    unobserve(target: Element): void { this.#observation.targets = this.#observation.targets.filter(t => t !== target); }
    disconnect(): void { this.#observation.targets = []; }
  }
  swap(globalThis, 'ResizeObserver', RecordingResizeObserver);
  swap(window, 'ResizeObserver', RecordingResizeObserver);
  swap(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  swap(globalThis, 'cancelAnimationFrame', (id: number) => { frames.delete(id); });
  // The GPU boundary: init() installs the controlled device instead of asking navigator.gpu.
  swap(Renderer.prototype, 'init', async function init(this: Renderer) {
    renderer = this;
    const canvas = (this as unknown as { canvas: HTMLCanvasElement }).canvas;
    gpus.push(installCaptureGpu(this, canvas, { complete: () => Promise.resolve(), submit: () => {}, resize: () => {} }));
    // The Viewport's own effects also write the pipeline's theme uniforms, which the capture fixture never needed.
    const state = this as unknown as { pipeline: object };
    const pipeline = state.pipeline;
    state.pipeline = new Proxy(pipeline, { get: (target, name, receiver) =>
      typeof name === 'string' && name.endsWith('Uniform') ? { update: () => {} } : Reflect.get(target, name, receiver) });
  });
  useViewerStore.setState({ activeTool: 'measure', measureMode: 'point', measurePointLive: null, measurePointLast: null });
});

afterEach(() => {
  cleanup();
  for (const gpu of gpus.reverse()) gpu.dispose();
  for (const undo of restore.splice(0).reverse()) undo();
});

function step(): void {
  time += 16;
  for (const [id, callback] of [...frames]) {
    if (frames.delete(id)) callback(time);
  }
}

const LIVE = { x: 1, y: 2, z: 3, screenX: 0, screenY: 0 };
const live = () => useViewerStore.getState().measurePointLive;

/** Mount the Viewport, let its renderer initialise, and return its canvas's resize reports. */
async function mountViewport() {
  const ui = render(<Viewport geometry={null} />);
  const canvas = ui.querySelector('canvas');
  assert.ok(canvas, 'the Viewport rendered no canvas');
  // Let the mount settle: the renderer effect may re-run (and re-create the renderer) before it does.
  for (let i = 0; i < 8; i++) await act(async () => { step(); });
  assert.ok(observations.some(o => o.targets.includes(canvas)), 'the initialised Viewport observes no canvas');
  assert.ok(renderer, 'the Viewport created no renderer');
  const viewportRenderer = renderer;
  // As a browser does: every observer of the canvas gets the report (the renderer watches its CSS size too).
  const report = (width: number, height: number) => act(() => {
    for (const o of observations.filter(o => o.targets.includes(canvas))) {
      o.callback([{ target: canvas, contentRect: { width, height } } as unknown as ResizeObserverEntry], o.observer);
    }
  });
  report(800, 400); // the observer's first report on observe()
  /** A resting cursor's Live reading, after the loop's measurement pass has caught up with the view. */
  const restingReading = () => {
    act(() => { useViewerStore.getState().setMeasurePointLive({ ...LIVE }); });
    act(() => { step(); });
    act(() => { useViewerStore.getState().setMeasurePointLive({ ...LIVE }); });
    act(() => { step(); step(); });
    assert.ok(live() !== null, 'fixture: idle frames must keep a Live reading');
  };
  return { renderer: viewportRenderer, report, restingReading };
}

it('a canvas resize that keeps the aspect ends Point mode\'s Live reading in the mounted Viewport (#9032, #8886)', async () => {
  const v = await mountViewport();
  v.restingReading();
  v.report(800, 400); // the window moved to a display with another pixel ratio: same CSS box
  act(() => { step(); });
  assert.ok(live() !== null, 'a pixel-ratio-only report ended Live');
  v.report(1200, 600); // a proportional window resize
  act(() => { step(); });
  assert.equal(live(), null, 'Live outlived a resize that keeps the aspect');
});

it('every canvas resize report asks the mounted Viewport for a frame (#9032)', async () => {
  const v = await mountViewport();
  act(() => { step(); step(); });
  v.renderer.consumeRenderRequest();
  v.report(800, 400);
  assert.equal(v.renderer.peekRenderRequest(), true, 'a resize report requested no render');
  v.renderer.consumeRenderRequest();
  v.report(1000, 500);
  assert.equal(v.renderer.peekRenderRequest(), true, 'a resize report requested no render');
});
