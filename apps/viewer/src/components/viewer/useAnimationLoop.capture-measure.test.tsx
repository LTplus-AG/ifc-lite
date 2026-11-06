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
import { it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { captureLifecycle } from '@/test/capture-lifecycle';
import { useViewerStore } from '@/store';
import { captureViewportFrame, registerViewportCapture, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';
import { GPU_FRAMES_IN_FLIGHT, GPU_FRAME_STALE_MS } from './gpuFramePacer.js';

type Lifecycle = Awaited<ReturnType<typeof captureLifecycle>>;

/** The loop with the Measure tool open over a cut, after its pass has run: a resting cursor's Live reading holds from here. */
async function restingReading(t: TestContext) {
  /** One entry per measurement pass that ran: did it count the view as moved (which ends Live)? */
  const passes: boolean[] = [];
  const h = await captureLifecycle(1, {
    hasPendingMeasurements: () => true,
    updateMeasurementScreenCoords: (_project, viewMoved = true) => { passes.push(viewMoved); },
  });
  t.after(() => h.dispose()); // also when a fixture assertion below throws (dispose is idempotent)
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
  it(`a tick after a capture that renders nothing keeps a resting Live reading: ${path} (#9031)`, async (t) => {
    const { h, passes, clip } = await restingReading(t);
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
      // Nothing else asks for a frame: the loop itself retries the live frame the pass waits on.
      h.params.snapEnabledRef.current = false; // a real change under the resting cursor (S)
      h.step();
      assert.ok(h.gpu.stats.submissions > submissions, `${path}: the loop stopped retrying the live frame`);
      assert.deepEqual(passes, [true], `${path}: a Snap toggle after the capture did not end Live`);
      passes.length = 0;
      h.params.snapEnabledRef.current = true;
      h.step();
      passes.length = 0;
      assertLiveFrameResumes(h, passes, clip, path);
    } finally { warn.mock.restore(); error.mock.restore(); await h.dispose(); }
  });
}

it('a tick after a capture that the GPU backlog holds back keeps a resting Live reading (#9031)', async (t) => {
  // The frame pacer reads performance.now(): hold it still, so only the test decides when frames go stale.
  const realNow = performance.now.bind(performance);
  const clockStart = realNow();
  let elapsed = 0;
  performance.now = () => clockStart + elapsed;
  t.after(() => { performance.now = realNow; });
  const { h, passes, clip } = await restingReading(t);
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
    // The held-back frames go stale, so the pacer lets the loop draw again.
    elapsed += GPU_FRAME_STALE_MS + 1;
    assertLiveFrameResumes(h, passes, clip, 'GPU backlog');
  } finally { await h.dispose(); }
});

for (const stage of ['encode', 'finish', 'submit'] as const) {
  it(`a capture frame refused at ${stage}, after it noted its clip, keeps a resting Live reading (#9031)`, async (t) => {
    const { h, passes, clip } = await restingReading(t);
    const warn = mock.method(console, 'warn', () => {});
    const error = mock.method(console, 'error', () => {});
    try {
      let restore = h.gpu.refuse(stage);
      const shot = captureViewportFrame(h.renderer, { options: { sectionPlane: undefined }, read: canvas => canvas.toDataURL() });
      await h.flush();
      assert.equal(await shot, null, 'fixture: the capture frame must be refused');
      assert.notEqual(h.renderer.getPickClipRevision(), clip, 'fixture: the refused frame must still give the pickers its clip');
      assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
      assert.equal(h.renderer.peekRenderRequest(), true, 'the refused capture asked for no frame');
      restore();
      restore = h.gpu.refuse('texture');
      h.step(); h.step(); // the loop's next frames render nothing
      assert.deepEqual(passes, [], `a tick after a capture refused at ${stage} ended Live`);
      restore();
      assertLiveFrameResumes(h, passes, clip, `refused at ${stage}`);
    } finally { warn.mock.restore(); error.mock.restore(); }
  });
}

it('a render that throws after a capture keeps its single retry, not one per frame (#9031)', async (t) => {
  const { h, passes, clip } = await restingReading(t);
  const warn = mock.method(console, 'warn', () => {});
  try {
    const shot = await startCapture(h, clip);
    assert.ok(await finishCapture(h, shot));
    const render = h.renderer.renderWithResult;
    let attempts = 0;
    h.renderer.renderWithResult = () => { attempts++; throw new Error('controlled uncontained render throw'); };
    try { for (let i = 0; i < 5; i++) h.step(); }
    finally { h.renderer.renderWithResult = render; }
    assert.equal(attempts, 2, 'a throwing frame retried every frame while the pass waited on a live frame');
    assert.deepEqual(passes, [], 'a throwing frame ended Live');
  } finally { warn.mock.restore(); }
});

it('a capture whose session is replaced keeps a resting Live reading until the loop draws again (#9031)', async (t) => {
  const { h, passes, clip } = await restingReading(t);
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
