/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLandXmlViewerModelAsync } from './landXmlViewerModel.js';

it('terminates LandXML worker parsing within the cancellation polling bound (#5041)', async () => {
  const originalWorker = globalThis.Worker;
  let terminated = 0;
  class PendingWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(): void {}
    terminate(): void { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: PendingWorker as unknown as typeof Worker,
  });
  let current = true;
  const started = performance.now();
  try {
    const pending = parseLandXmlViewerModelAsync(new ArrayBuffer(8), () => current);
    current = false;
    await assert.rejects(pending, /LandXML parsing cancelled/);
    assert.equal(terminated, 1);
    assert.ok(performance.now() - started < 250, 'cancellation must not wait for synchronous WASM completion');
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});
