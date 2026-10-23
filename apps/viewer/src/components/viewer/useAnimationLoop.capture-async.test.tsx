/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import { captureLifecycle } from '@/test/capture-lifecycle';
import { captureViewportFrame, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';

// Root viewer typecheck verifies these negative contracts; never invoked.
function rejectsAsyncReaders(renderer: Renderer): void {
  // @ts-expect-error An inferred Promise cannot satisfy the synchronous reader contract.
  void captureViewportFrame(renderer, { read: async canvas => canvas.toDataURL() });
  // @ts-expect-error A mixed result cannot conceal an asynchronous pixel read.
  void captureViewportFrame(renderer, { read: () => Math.random() > 0.5 ? 'pixels' : Promise.resolve('pixels') });
  // @ts-expect-error Custom thenables are asynchronous results too.
  void captureViewportFrame(renderer, { read: () => ({ then: (resolve: (value: string) => void) => resolve('pixels') }) });
}
void rejectsAsyncReaders;

it('refuses a delayed pixel reader after presentation and permits the next capture (#6709)', async () => {
  const h = await captureLifecycle(2);
  const warning = mock.method(console, 'warn', () => {});
  const error = mock.method(console, 'error', () => {});
  let resume = () => {};
  const delayed = new Promise<void>(resolve => { resume = resolve; });
  let restored = 0;
  try {
    h.step();
    // Unknown models an untyped/JavaScript caller bypassing the compile-time contract.
    const refused = captureViewportFrame<unknown>(h.renderer, {
      prepare: () => () => { restored++; },
      read: async canvas => { await delayed; return canvas.toDataURL(); },
    });
    let settled = false;
    void refused.then(() => { settled = true; });
    await h.flush(); h.step(); await h.flush();
    assert.equal(settled, true, 'refusal must not wait for the invalid reader promise');
    assert.equal(await refused, null, 'a reader promise cannot become a successful capture');
    assert.equal(restored, 1);
    assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
    h.step(); // The real lifecycle fixture expires the drawing buffer here.
    resume(); await h.flush();
    assert.equal(h.captures.length, 0, 'late serialization cannot publish expired pixels');
    assert.equal(error.mock.callCount(), 1, 'late rejection is consumed and reported');
    const next = h.bcf.captureSnapshot(); await h.flush(); h.step(); await h.flush();
    assert.ok(await next, 'refusal does not poison the canonical capture queue');
    assert.equal(h.captures.length, 1);
  } finally { resume(); await h.flush(); warning.mock.restore(); error.mock.restore(); await h.dispose(); }
});

for (const kind of ['promise', 'thenable', 'function-thenable']) {
  it(`consumes a refused ${kind} rejection and restores the capture lease (#6709)`, async () => {
    const h = await captureLifecycle(2);
    const warning = mock.method(console, 'warn', () => {});
    const error = mock.method(console, 'error', () => {});
    const failure = new Error('controlled asynchronous reader failure');
    let restored = 0;
    try {
      h.step();
      const then = (_resolve: unknown, reject: (reason: Error) => void) => reject(failure);
      const refused = captureViewportFrame<unknown>(h.renderer, {
        prepare: () => () => { restored++; },
        read: () => kind === 'promise' ? Promise.reject(failure) :
          kind === 'thenable' ? { then } : Object.assign(() => 'unused', { then }),
      });
      let settled = false;
      void refused.then(() => { settled = true; });
      await h.flush(); h.step(); await h.flush();
      assert.equal(settled, true, 'an invalid asynchronous result cannot hold the queue');
      assert.equal(await refused, null);
      assert.equal(restored, 1);
      assert.equal(viewportCaptureOwnsFrame(h.renderer), false);
      assert.equal(h.captures.length, 0);
      assert.equal(warning.mock.callCount(), 1);
      assert.equal(error.mock.callCount(), 1);
      assert.strictEqual(error.mock.calls[0]?.arguments[1], failure);
    } finally { warning.mock.restore(); error.mock.restore(); await h.dispose(); }
  });
}
