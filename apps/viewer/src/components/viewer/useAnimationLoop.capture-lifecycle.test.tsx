/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureLifecycle } from '@/test/capture-lifecycle';
import { useViewerStore } from '@/store';
import { captureViewportFrame, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';
import { captureEntityViewportFrame } from '@/lib/export/entity-viewport-capture';

it('preserves the canonical appearance, section and visibility options in an owned frame (#6709)', async () => {
  const h = await captureLifecycle(2);
  try {
    h.params.environmentRef.current = { exposure: 1.7 };
    h.params.visualEnhancementRef.current = { enabled: true, contactShading: { quality: 'high', intensity: 0.7 } };
    h.params.sunShadowsRef.current = { enabled: true, resolution: 2048, sunAngleDeg: 30 };
    h.params.terrainClipYRef.current = 3;
    h.params.hiddenEntitiesRef.current = new Set([99]);
    h.params.isolatedEntitiesRef.current = new Set([7]);
    h.params.ghostExceptEntitiesRef.current = new Set([7]);
    h.params.sectionPlaneRef.current = { ...h.params.sectionPlaneRef.current, axis: 'down', position: 50, enabled: true, flipped: false };
    useViewerStore.setState(state => ({ sceneState: { ...state.sceneState, section: { ...state.sceneState.section, visible: true } } }));
    h.params.isInteractingRef.current = true;
    h.step();
    const ordinary = h.frames.at(-1);
    assert.ok(ordinary?.sectionPlane, 'fixture must exercise an actual section cut');
    h.deferWork();
    const capture = h.bcf.captureSnapshot();
    await h.flush();
    const owned = h.frames.at(-1);
    assert.ok(owned);
    for (const field of ['environment', 'visualEnhancement', 'sunShadows', 'terrainClipY', 'sectionPlane', 'clipBox', 'clearColor'] as const) {
      assert.deepEqual(owned[field], ordinary[field], `capture preserves ${field}`);
    }
    assert.deepEqual([...(owned.hiddenIds ?? [])], [99]);
    assert.deepEqual([...(owned.isolatedIds ?? [])], [7]);
    assert.deepEqual([...(owned.ghostExceptIds ?? [])], [7]);
    assert.equal(owned.isInteracting, false);
    assert.equal(owned.maxPixelRatio, undefined);
    assert.equal(owned.restoreEvictedForCapture, true);
    h.params.hiddenEntitiesRef.current.add(100);
    assert.deepEqual([...(owned.hiddenIds ?? [])], [99], 'the image keeps requested visibility during asynchronous store changes');
    const count = h.frames.length;
    h.step(); h.step();
    assert.equal(h.frames.length, count, 'normal loop cannot render over the owned frame');
    h.finishWork(); await h.flush(); h.step(); await h.flush();
    assert.ok(await capture);
  } finally { await h.dispose(); }
});

it('releases ownership on GPU failure and permits the next capture (#6709)', async () => {
  const h = await captureLifecycle(2);
  const errors = mock.method(console, 'error', () => {});
  try {
    h.params.isInteractingRef.current = true; h.step();
    h.deferWork();
    const failed = h.bcf.captureSnapshot(); await h.flush();
    assert.equal(viewportCaptureOwnsFrame(h.renderer), true);
    h.failWork(new Error('controlled GPU completion failure'));
    assert.equal(await failed, null);
    assert.equal(errors.mock.callCount(), 1, 'failure is reported');
    assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
    h.step(); assert.deepEqual([h.canvas.width, h.canvas.height], [600, 400]);
    const next = h.bcf.captureSnapshot(); await h.flush(); h.step(); await h.flush();
    assert.ok(await next, 'failed work must not poison the capture queue');
    assert.deepEqual([h.captures[0]?.width, h.captures[0]?.height], [1200, 800]);
  } finally { errors.mock.restore(); await h.dispose(); }
});

for (const deferred of [true, false]) {
  it(`cancels active and queued captures on unmount during ${deferred ? 'GPU completion' : 'presentation'} (#6709)`, async () => {
    const h = await captureLifecycle(2);
    try {
      h.step();
      if (deferred) h.deferWork();
      const first = h.bcf.captureSnapshot();
      const queued = h.bcf.captureSnapshot();
      await h.flush();
      assert.equal(viewportCaptureOwnsFrame(h.renderer), true);
      await h.dispose();
      assert.equal(await first, null);
      assert.equal(await queued, null);
      assert.equal(h.captures.length, 0, 'disposed canvas is never read');
      h.finishWork(); await h.flush();
      assert.equal(h.captures.length, 0, 'late completion cannot resurrect a capture');
    } finally { await h.dispose(); }
  });
}

it('restores a framed export camera on readback failure without changing store channels (#6709)', async () => {
  const h = await captureLifecycle(2);
  const errors = mock.method(console, 'error', () => {});
  try {
    h.step();
    const camera = h.renderer.getCamera();
    const before = { ...camera.getPosition() };
    const state = useViewerStore.getState();
    h.canvas.toDataURL = () => { throw new Error('controlled canvas readback failure'); };
    const capture = captureEntityViewportFrame(h.renderer, {
      ids: new Set([7]), mode: 'isolate', clearColor: [0, 0, 0, 1],
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 8, z: 4 } },
    });
    await h.flush();
    assert.notDeepEqual(camera.getPosition(), before, 'the actual canonical immediate framing ran');
    h.step(); await h.flush();
    assert.equal(await capture, null);
    assert.deepEqual(camera.getPosition(), before);
    assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
    assert.strictEqual(useViewerStore.getState().isolatedEntities, state.isolatedEntities);
    assert.strictEqual(useViewerStore.getState().selectedEntityIds, state.selectedEntityIds);
    assert.equal(errors.mock.callCount(), 1);
  } finally { errors.mock.restore(); await h.dispose(); }
});

it('rejects a canvas from another viewport instead of returning the wrong image (#6709)', async () => {
  const h = await captureLifecycle(2);
  const warnings = mock.method(console, 'warn', () => {});
  try {
    const result = await captureViewportFrame(h.renderer, {
      canvas: document.createElement('canvas'), read: canvas => canvas.toDataURL(),
    });
    assert.equal(result, null);
    assert.equal(h.captures.length, 0);
    assert.equal(warnings.mock.callCount(), 1);
  } finally { warnings.mock.restore(); await h.dispose(); }
});
