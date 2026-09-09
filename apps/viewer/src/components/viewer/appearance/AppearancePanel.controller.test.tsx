/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAppearanceControllerScenario } from '@/test/appearance-controller.harness.js';

const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
afterEach(() => {
  if (bitmapDescriptor) Object.defineProperty(globalThis, 'createImageBitmap', bitmapDescriptor);
  else Reflect.deleteProperty(globalThis, 'createImageBitmap');
});

for (const scenario of ['strict-source', 'discard-debounce', 'discard-worker', 'stale-version', 'upload-failure'] as const) {
  it(`mounted AppearancePanel #4243: ${scenario}`, async () => {
    let decodes = 0, closes = 0;
    // HappyDOM has no bitmap decoder. The same harness runs with unmodified
    // createImageBitmap in the browser; here only that host boundary is supplied.
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: async (input: Blob) => {
      const bytes = new Uint8Array(await input.arrayBuffer());
      assert.deepEqual(Array.from(bytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
      decodes++;
      return { width: 1, height: 1, close() { closes++; } } as ImageBitmap;
    } });
    const result = await runAppearanceControllerScenario(scenario);
    assert.equal(result.requests, scenario === 'discard-debounce' ? 0 : scenario === 'strict-source' ? 2 : 1);
    assert.equal(result.terminations, result.requests);
    assert.equal(decodes, scenario === 'discard-debounce' ? 0 : 1);
    assert.equal(closes, decodes, 'last library/draft owner closes decoded image exactly once');
  });
}
