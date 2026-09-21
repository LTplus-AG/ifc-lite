/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { probeLandXmlAlignmentInWorker } from './landXmlProbe.js';

it('terminates an alignment probe worker when transferable posting fails (#5044)', async () => {
  const originalWorker = globalThis.Worker;
  let terminated = 0;
  class ThrowingWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(): void { throw new DOMException('transfer failed', 'DataCloneError'); }
    terminate(): void { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ThrowingWorker as unknown as typeof Worker });
  try {
    await assert.rejects(probeLandXmlAlignmentInWorker(new ArrayBuffer(8), {
      alignmentSourceId: 'alignment', mode: 'distance', value: 0, offsetRight: 0,
    }, new AbortController().signal), /transfer failed/);
    assert.equal(terminated, 1);
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});
