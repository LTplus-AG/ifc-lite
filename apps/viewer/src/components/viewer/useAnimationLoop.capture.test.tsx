/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureLifecycle } from '@/test/capture-lifecycle';
import { createSnapshotCapture } from '@/lib/export/report/snapshots';

for (const dpr of [2, 1]) {
  describe(`canonical capture ownership at DPR${dpr} (#6709)`, () => {
    it('captures a full-quality BCF frame while a 300ms camera tween is active', async () => {
      const h = await captureLifecycle(dpr);
      try {
        h.step();
        void h.renderer.getCamera().frameBounds({ x: 0, y: 0, z: 0 }, { x: 5, y: 8, z: 4 }, 300);
        h.step(); h.step(); // The existing clash-topic caller waits just two frames.
        assert.deepEqual([h.canvas.width, h.canvas.height], [600, 400], 'active frame is CSS resolution');
        const capturePose = { ...h.renderer.getCamera().getPosition() };
        h.deferWork();
        const capture = h.bcf.createViewpointFromState({ includeSnapshot: true, includeHidden: false, includeSelection: false });
        await h.flush();
        assert.ok(h.waits > 0, 'capture must have reached actual GPU-completion boundary');
        h.step(); h.step();
        h.finishWork(); await h.flush(); h.step(); await h.flush();
        const viewpoint = await capture;
        assert.ok(viewpoint?.snapshot);
        console.log(JSON.stringify({ evidence: '#6709 BCF active-tween readback', dpr, captures: h.captures }));
        assert.deepEqual([h.captures[0]?.width, h.captures[0]?.height], [600 * dpr, 400 * dpr]);
        assert.deepEqual(h.captures[0]?.camera, capturePose, 'the capture owns its camera frame while GPU completion yields');
        assert.equal(viewpoint.perspectiveCamera?.aspectRatio, 1.5);
        for (let i = 0; i < 24; i++) h.step();
        assert.deepEqual([h.canvas.width, h.canvas.height], [600 * dpr, 400 * dpr], 'settled quality is restored');
      } finally { await h.dispose(); }
    });

    it('keeps the actual report export frame through navigation and deferred readback', async () => {
      const h = await captureLifecycle(dpr);
      try {
        h.step();
        h.params.isInteractingRef.current = true;
        h.step();
        const exporter = createSnapshotCapture();
        assert.ok(exporter);
        h.deferWork();
        const capture = exporter.capture([7]);
        await h.flush();
        assert.deepEqual([h.canvas.width, h.canvas.height], [600 * dpr, 400 * dpr], 'explicit capture render starts full quality');
        h.step(); h.step(); // Real loop tries to overwrite the capture while its GPU work is pending.
        h.finishWork(); await h.flush(); h.step(); await h.flush();
        assert.ok(await capture);
        console.log(JSON.stringify({ evidence: '#6709 overlapping report readback', dpr, captures: h.captures }));
        assert.deepEqual([h.captures[0]?.width, h.captures[0]?.height], [600 * dpr, 400 * dpr]);
        assert.deepEqual(h.captures[0]?.ghostIds, [7], 'readback belongs to the export, including DPR1 where dimensions cannot expose overwrite');
        exporter.restore();
        h.params.isInteractingRef.current = false;
        h.step();
        assert.deepEqual([h.canvas.width, h.canvas.height], [600 * dpr, 400 * dpr]);
      } finally { await h.dispose(); }
    });
  });
}

it('keeps a consumer cap below DPR2 across capture and resumed navigation (#6709)', async () => {
  const h = await captureLifecycle(2);
  try {
    h.renderer.setMaxPixelRatio(1.5);
    h.params.isInteractingRef.current = true;
    h.step();
    h.deferWork();
    const capture = h.bcf.captureSnapshot();
    await h.flush(); h.step();
    h.finishWork(); await h.flush(); h.step(); await h.flush();
    assert.ok(await capture);
    assert.deepEqual([h.captures[0]?.width, h.captures[0]?.height], [900, 600]);
    h.step();
    assert.deepEqual([h.canvas.width, h.canvas.height], [600, 400]);
    h.params.isInteractingRef.current = false;
    h.step();
    assert.deepEqual([h.canvas.width, h.canvas.height], [900, 600], 'capture must not mutate persistent quality preference');
  } finally { await h.dispose(); }
});

it('serializes two real report captures through deferred completion at DPR1 (#6709)', async () => {
  const h = await captureLifecycle(1);
  try {
    h.step();
    const exporter = createSnapshotCapture();
    assert.ok(exporter);
    h.deferWork();
    const first = exporter.capture([7]);
    const second = exporter.capture([8]);
    await h.flush(); h.step();
    h.finishWork();
    // The two ownership intervals each need a presentation frame.
    for (let i = 0; i < 6; i++) { await h.flush(); h.step(); }
    assert.ok(await first); assert.ok(await second);
    console.log(JSON.stringify({ evidence: '#6709 concurrent report readbacks', dpr: 1, captures: h.captures }));
    assert.deepEqual(h.captures.map(capture => capture.ghostIds), [[7], [8]]);
    exporter.restore();
  } finally { await h.dispose(); }
});
