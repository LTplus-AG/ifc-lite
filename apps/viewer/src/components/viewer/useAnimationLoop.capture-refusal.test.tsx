/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureLifecycle } from '@/test/capture-lifecycle';
import type { CaptureRenderRefusal } from '@/test/capture-gpu';
import { captureViewportFrame, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';

const refusals: CaptureRenderRefusal[] = ['uninitialized', 'pipeline', 'lost', 'collapsed',
  'context', 'texture', 'resize', 'encode', 'finish', 'submit'];

for (const dpr of [2, 1]) {
  for (const refusal of refusals) {
    it(`refuses a stale capture after actual Renderer ${refusal} refusal at DPR${dpr} (#6709)`, async () => {
      const h = await captureLifecycle(dpr);
      const warn = mock.method(console, 'warn', () => {});
      const error = mock.method(console, 'error', () => {});
      try {
        h.renderer.requestRender(); h.step();
        assert.ok(h.gpu.stats.submissions > 0, 'fixture must first submit an actual canonical frame');
        const previous = h.gpu.stats.submissions;
        const waits = h.waits;
        let reads = 0;
        let metadataReads = 0;
        const captured = captureViewportFrame(h.renderer, {
          prepare: () => h.gpu.refuse(refusal),
          afterRender: () => { metadataReads++; },
          read: canvas => { reads++; return canvas.toDataURL('image/png'); },
        });
        await h.flush();
        const submissionsAfterAttempt = h.gpu.stats.submissions;
        const waitsAfterAttempt = h.waits;
        h.step(); await h.flush();
        const result = await captured;
        console.log(JSON.stringify({ evidence: '#6709 render refusal', dpr, refusal,
          priorSubmission: previous, submissionsAfterAttempt, reads, completionWaits: waitsAfterAttempt - waits }));
        assert.equal(result, null, 'skipped or contained render failure must not return the previous canvas frame');
        assert.equal(reads, 0, 'readback is unreachable until the owned render submits');
        assert.equal(metadataReads, 0, 'no camera metadata is paired with a refused frame');
        assert.equal(submissionsAfterAttempt, previous, 'canonical queue submitted no refused frame');
        assert.equal(waitsAfterAttempt, waits, 'old work completion is not evidence of a new submitted frame');
        assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
        assert.equal(h.gpu.stats.pushedScopes, h.gpu.stats.poppedScopes, 'existing error-scope cleanup stays balanced');
      } finally { warn.mock.restore(); error.mock.restore(); await h.dispose(); }
    });
  }

  it(`reads the newly submitted owned frame after deferred completion at DPR${dpr} (#6709)`, async () => {
    const h = await captureLifecycle(dpr);
    try {
      h.renderer.requestRender(); h.step();
      assert.ok(h.gpu.stats.submissions > 0, 'fixture must first submit an actual canonical frame');
      const previous = h.gpu.stats.submissions;
      h.deferWork();
      const captured = h.bcf.captureSnapshot();
      await h.flush();
      assert.equal(h.gpu.stats.submissions, previous + 1, 'real owned render reached queue.submit');
      assert.equal(h.captures.length, 0, 'submission alone does not permit readback before completion');
      h.step(); h.step();
      assert.equal(h.gpu.stats.submissions, previous + 1, 'loop cannot replace the submitted owned frame');
      h.finishWork(); await h.flush(); h.step(); await h.flush();
      assert.ok(await captured);
      assert.equal(h.captures[0]?.submission, previous + 1, 'readback belongs to this submission, not the old frame');
      assert.deepEqual([h.captures[0]?.width, h.captures[0]?.height], [600 * dpr, 400 * dpr]);
    } finally { await h.dispose(); }
  });
}

it('releases refusal ownership and lets a queued canonical capture submit (#6709)', async () => {
  const h = await captureLifecycle(2);
  const warn = mock.method(console, 'warn', () => {});
  const error = mock.method(console, 'error', () => {});
  try {
    h.renderer.requestRender(); h.step();
    assert.ok(h.gpu.stats.submissions > 0, 'fixture must first submit an actual canonical frame');
    const previous = h.gpu.stats.submissions;
    const refused = captureViewportFrame(h.renderer, {
      prepare: () => h.gpu.refuse('encode'), read: canvas => canvas.toDataURL('image/png'),
    });
    const queued = h.bcf.captureSnapshot();
    for (let i = 0; i < 2; i++) { await h.flush(); h.step(); }
    await h.flush();
    assert.equal(await refused, null);
    assert.ok(await queued);
    assert.deepEqual(h.captures.map(capture => capture.submission), [previous + 1]);
    assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
  } finally { warn.mock.restore(); error.mock.restore(); await h.dispose(); }
});
