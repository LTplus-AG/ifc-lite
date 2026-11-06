/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9031: a capture render (IDS/BCF viewpoint export) draws its frame with the
 * section cleared, so until the live loop draws again the pickers, and the
 * renderer's pick-clip revision, mirror the capture's clip (#9002). The loop's
 * Measure pass compares that revision to tell whether a resting cursor's Point
 * "Live" reading still holds (#8886). A tick after the capture that renders
 * nothing must not compare it, or the reading ends although the user's view
 * never changed. Real loop, renderer and capture queue; only the GPU is
 * controlled (`capture-gpu.ts`).
 */

import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureLifecycle } from '@/test/capture-lifecycle';
import { useViewerStore } from '@/store';
import { captureViewportFrame, registerViewportCapture, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';
import { GPU_FRAMES_IN_FLIGHT } from './gpuFramePacer.js';

type Lifecycle = Awaited<ReturnType<typeof captureLifecycle>>;

/** The loop with the Measure tool open over a cut, after its pass has run: a resting cursor's Live reading holds from here. */
async function restingReading() {
  /** One entry per measurement pass that ran: did it count the view as moved (which ends Live)? */
  const passes: boolean[] = [];
  const h = await captureLifecycle(1, {
    hasPendingMeasurements: () => true,
    updateMeasurementScreenCoords: (_project, viewMoved = true) => { passes.push(viewMoved); },
  });
  h.params.activeToolRef.current = 'measure';
  h.params.sectionPlaneRef.current = { ...h.params.sectionPlaneRef.current, axis: 'down', position: 50, enabled: true, flipped: false };
  useViewerStore.setState(state => ({ sceneState: { ...state.sceneState, section: { ...state.sceneState.section, visible: true } } }));
  h.renderer.requestRender(); h.step();
  h.renderer.requestRender(); h.step();
  assert.ok(h.frames.at(-1)?.sectionPlane, 'fixture must draw an actual section cut');
  assert.ok(passes.length > 0, 'the loop ran no measurement pass');
  passes.length = 0;
  return { h, passes, clip: h.renderer.getPickClipRevision() };
}

/** An IDS/BCF-style capture with the cut cleared; resolves once it has drawn and holds the frame. */
async function startCapture(h: Lifecycle, clip: number) {
  const shot = captureViewportFrame(h.renderer, { options: { sectionPlane: undefined }, read: canvas => canvas.toDataURL() });
  await h.flush();
  assert.equal(viewportCaptureOwnsFrame(h.renderer), true);
  assert.notEqual(h.renderer.getPickClipRevision(), clip, 'fixture: the capture frame must give the pickers its own clip');
  return { shot }; // wrapped: awaiting the capture itself would wait for its presentation
}

/** Present the capture frame and let it hand the frame back. */
async function finishCapture(h: Lifecycle, { shot }: { shot: Promise<unknown> }) {
  h.step(); await h.flush();
  assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
  return shot;
}

/** The loop draws again: the pickers return to the live cut, and the reading still holds; a real view change still ends it. */
function assertLiveFrameResumes(h: Lifecycle, passes: boolean[], clip: number, path: string) {
  h.renderer.requestRender(); h.step();
  assert.equal(h.renderer.getPickClipRevision(), clip, `${path}: the live frame did not restore the cut's revision`);
  assert.deepEqual(passes, [], `${path}: the first live frame after the capture ended Live`);
  assert.equal(h.params.lastCameraStateRef.current?.scene.clip, clip, `${path}: the pass compares against the capture's clip`);
  const camera = h.renderer.getCamera();
  const p = camera.getPosition();
  camera.setPosition(p.x + 1, p.y, p.z);
  h.renderer.requestRender(); h.step();
  assert.deepEqual(passes, [true], `${path}: a camera move after the capture no longer ends Live`);
}

const notRendering = [
  ['getCurrentTexture() returns null', 'texture'],
  ['the device is lost', 'lost'],
  ['the device is not initialized', 'uninitialized'],
] as const;

for (const [path, mode] of notRendering) {
  it(`a tick after a capture that renders nothing keeps a resting Live reading: ${path} (#9031)`, async () => {
    const { h, passes, clip } = await restingReading();
    const warn = mock.method(console, 'warn', () => {});
    const error = mock.method(console, 'error', () => {});
    try {
      const shot = await startCapture(h, clip);
      const restore = h.gpu.refuse(mode);
      assert.ok(await finishCapture(h, shot), 'the capture itself completed');
      const submissions = h.gpu.stats.submissions;
      h.step(); h.step();
      assert.equal(h.gpu.stats.submissions, submissions, 'fixture: these ticks must render nothing');
      assert.deepEqual(passes, [], `a pass read the capture's clip and ended Live (${path})`);
      restore();
      assertLiveFrameResumes(h, passes, clip, path);
    } finally { warn.mock.restore(); error.mock.restore(); await h.dispose(); }
  });
}

it('a tick after a capture that the GPU backlog holds back keeps a resting Live reading (#9031)', async () => {
  const { h, passes, clip } = await restingReading();
  try {
    // GPU_FRAMES_IN_FLIGHT live frames whose completion never arrives, then
    // a queue that completes again, so the capture's own wait resolves.
    h.deferWork();
    for (let i = 0; i < GPU_FRAMES_IN_FLIGHT; i++) { h.renderer.requestRender(); h.step(); }
    h.deferWork(); h.finishWork();
    passes.length = 0;
    const shot = await startCapture(h, clip);
    assert.ok(await finishCapture(h, shot));
    const submissions = h.gpu.stats.submissions;
    h.step(); h.step();
    assert.equal(h.gpu.stats.submissions, submissions, 'fixture: the frame pacer must hold these frames back');
    assert.deepEqual(passes, [], 'a backlogged tick read the capture\'s clip and ended Live');
  } finally { await h.dispose(); }
});

it('a capture whose session is replaced keeps a resting Live reading until the loop draws again (#9031)', async () => {
  const { h, passes, clip } = await restingReading();
  let unregister = () => {};
  try {
    const shot = await startCapture(h, clip);
    // A new canonical session (the loop re-registering) aborts this capture,
    // whose `finally` then requests no render.
    unregister = registerViewportCapture(h.renderer, h.canvas, () => ({}));
    await h.flush();
    assert.equal(await shot.shot, null, 'fixture: the replaced capture must abort');
    assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
    const submissions = h.gpu.stats.submissions;
    h.step(); h.step();
    assert.equal(h.gpu.stats.submissions, submissions, 'fixture: nothing must request a frame');
    assert.deepEqual(passes, [], 'an idle tick read the capture\'s clip and ended Live');
    assertLiveFrameResumes(h, passes, clip, 'replaced session');
  } finally { unregister(); await h.dispose(); }
});
