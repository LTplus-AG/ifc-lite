/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9031: a capture (IDS/BCF viewpoint export) draws its own frame, with its
 * own camera and clip, and holds that frame while the GPU finishes and the
 * frame is presented. Until the live loop draws again, the pickers mirror the
 * capture's clip (#9002). A Point-mode hover pick in that window reads the
 * capture's view, not the one on screen. Driven through the mounted canvas
 * handlers and the real capture queue. The loop side (a tick that renders
 * nothing) is in useAnimationLoop.capture-measure.test.tsx.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { hasPendingMeasurementState } from '@/utils/viewportUtils.js';
import { cleanupMouseControls, mountMouseControls, mousePointer } from '@/test/mouse-controls-fixture';
import { captureViewportFrame, noteLiveFrameSubmitted, registerViewportCapture, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';
import { reprojectMeasurementsForCamera } from './measureCameraState.js';

const ON_WALL = { x: 3, y: 4, z: -5 };
const ELSEWHERE = { x: 7, y: 1, z: -2 };
const live = () => {
  const p = useViewerStore.getState().measurePointLive;
  return p ? [p.x, p.y, p.z] : null;
};

let initialState: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => {
  initialState = useViewerStore.getState();
  useViewerStore.setState({ activeTool: 'measure', measureMode: 'point', measurePointLive: null, measurePointLast: null, snapTarget: null });
});
afterEach(() => {
  cleanupMouseControls();
  useViewerStore.setState(initialState, true);
});

/** The mounted canvas in Point mode, its renderer driven by a capture the way the real one is. */
function capturing(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const frames: FrameRequestCallback[] = [];
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => frames.push(cb)) as typeof requestAnimationFrame;
  t.after(() => { globalThis.requestAnimationFrame = raf; });
  const updateMeasurementScreenCoords = useViewerStore.getState().updateMeasurementScreenCoords;
  const ui = mountMouseControls({
    activeToolRef: { current: 'measure' }, snapEnabledRef: { current: true }, HOVER_SNAP_THROTTLE_MS: 100,
    // As Viewport passes them in.
    updateMeasurementScreenCoords,
    hasPendingMeasurements: () => hasPendingMeasurementState(useViewerStore.getState()),
  });
  const clip = { revision: 0 };
  let picks = 0;
  let renderRequests = 0;
  const renderer = Object.assign(ui.params.rendererRef.current as unknown as Record<string, unknown>, {
    getPickClipRevision: () => clip.revision,
    requestRender: () => { renderRequests++; },
    getGPUDevice: () => null,
    // A capture frame gives the pickers its own clip and revision (#9002).
    renderWithResult: (options: { restoreEvictedForCapture?: boolean }) => {
      if (options.restoreEvictedForCapture) clip.revision = 99;
      return true;
    },
    // The cursor at x=70 is over ELSEWHERE, anywhere else over ON_WALL, so a pick shows the position it read.
    raycastSceneMagnetic: (x: number) => (picks++, {
      intersection: { point: x === 70 ? ELSEWHERE : ON_WALL }, snapTarget: null,
      edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
    }),
  }) as unknown as Renderer;
  let unregister = registerViewportCapture(renderer, ui.canvas, () => ({}));
  t.after(() => unregister());
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    flush,
    picks: () => picks,
    /** The loop re-registers its capture session, which aborts a capture in flight. */
    replaceSession: () => { unregister(); unregister = registerViewportCapture(renderer, ui.canvas, () => ({})); },
    renderRequests: () => renderRequests,
    move: (x: number) => act(() => { ui.canvas.dispatchEvent(mousePointer('pointermove', 0, x, 40, { buttons: 0 })); }),
    leave: () => act(() => { ui.canvas.dispatchEvent(new MouseEvent('mouseleave')); }),
    runFrames: () => act(() => { for (const cb of frames.splice(0)) cb(0); }),
    tick: (ms: number) => act(() => { t.mock.timers.tick(ms); }),
    /** The live loop's frame: it draws the live clip again, then runs its measurement pass. */
    liveFrame: () => {
      clip.revision = 0;
      noteLiveFrameSubmitted(renderer);
      reprojectMeasurementsForCamera(ui.camera, ui.canvas, { ...ui.params, renderer }, updateMeasurementScreenCoords);
    },
    /** Start a capture; resolves once it has drawn and holds the frame. */
    async capture() {
      const shot = captureViewportFrame(renderer, { read: () => 'pixels' });
      await flush();
      assert.equal(viewportCaptureOwnsFrame(renderer), true, 'fixture: the capture must hold the frame');
      return { shot }; // wrapped: awaiting the capture itself would wait for its presentation
    },
    /** The capture frame presents (with any hover frame queued) and hands the frame back. */
    async present(shot: Promise<unknown>) {
      this.runFrames();
      await flush();
      assert.equal(await shot, 'pixels');
      assert.equal(viewportCaptureOwnsFrame(renderer), false);
    },
  };
}

describe('Point mode hover and a viewport capture (#9031)', () => {
  it('a trailing hover pick during a capture waits for the live frame, then reads the resting cursor', async (t) => {
    const h = capturing(t);
    h.move(30); h.runFrames();
    h.liveFrame();
    assert.deepEqual(live(), [3, 4, -5]);
    h.tick(10);
    h.move(70); // throttled: a trailing pick for the resting cursor
    const { shot } = await h.capture();
    const picks = h.picks();
    h.tick(90); // the trailing pick fires while the capture holds the frame
    const requests = h.renderRequests();
    await h.present(shot); // its hover frame runs with the capture frame's presentation
    assert.equal(h.picks(), picks, 'a hover picked through the capture\'s camera and clip');
    assert.ok(h.renderRequests() > requests, 'a held-back hover asks for the frame it waits on');
    h.tick(100); h.runFrames(); // the capture is done, but the pickers still mirror its clip
    assert.equal(h.picks(), picks, 'a hover picked through the capture\'s clip before the live frame');
    h.liveFrame();
    h.tick(100); h.runFrames();
    assert.equal(h.picks(), picks + 1, 'the held-back hover never read the resting cursor');
    h.liveFrame();
    assert.deepEqual(live(), [7, 1, -2], 'the resting cursor lost its Live reading');
  });

  it('a held-back hover asks for the frame it waits on when the capture released none (replaced session)', async (t) => {
    const h = capturing(t);
    h.move(30); h.runFrames();
    h.liveFrame();
    h.tick(100);
    const { shot } = await h.capture();
    h.replaceSession(); // the aborted capture's finally requests no render
    h.runFrames(); await h.flush();
    assert.equal(await shot, null, 'fixture: the replaced capture must abort');
    const requests = h.renderRequests();
    h.move(70); h.runFrames(); // held back: the pickers still mirror the capture's clip
    assert.ok(h.renderRequests() > requests, 'a held-back hover left the idle loop with no frame to draw');
    h.liveFrame(); // the frame it asked for
    h.tick(100); h.runFrames();
    assert.deepEqual(live(), [7, 1, -2], 'the held-back hover never read the resting cursor');
  });

  it('a held-back hover frame leaves a trailing pick for a later cursor position in place', async (t) => {
    const h = capturing(t);
    h.move(30); h.runFrames();
    h.tick(100);
    const { shot } = await h.capture();
    h.move(30); // a hover frame for the old position, queued
    h.tick(10);
    h.move(70); // throttled: the trailing pick for the later position
    const picks = h.picks();
    await h.present(shot); // the queued frame is held back
    assert.equal(h.picks(), picks, 'a hover picked through the capture\'s camera and clip');
    h.liveFrame();
    h.tick(200); h.runFrames();
    assert.deepEqual(live(), [7, 1, -2], 'the held-back frame replaced the later position\'s pick');
    h.tick(200); h.runFrames();
    assert.deepEqual(live(), [7, 1, -2], 'the old position was read after the later one');
  });

  it('leaving the canvas drops a held-back hover', async (t) => {
    const h = capturing(t);
    const { shot } = await h.capture();
    h.move(30); // held back when its frame runs
    await h.present(shot);
    assert.equal(h.picks(), 0, 'fixture: the hover must be held back');
    h.leave();
    h.liveFrame();
    const picks = h.picks();
    h.tick(500); h.runFrames();
    assert.equal(h.picks(), picks, 'a held-back hover picked after the cursor left the canvas');
    assert.equal(live(), null);
  });

  it('a mode switch drops a held-back hover', async (t) => {
    const h = capturing(t);
    const { shot } = await h.capture();
    h.move(30);
    await h.present(shot);
    assert.equal(h.picks(), 0, 'fixture: the hover must be held back');
    act(() => { useViewerStore.getState().setMeasureMode('polyline'); });
    h.liveFrame();
    const picks = h.picks();
    h.tick(500); h.runFrames();
    assert.equal(h.picks(), picks, 'a held-back Point hover picked in Polyline mode');
    assert.equal(live(), null);
  });
});
