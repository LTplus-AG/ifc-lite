/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

// Only the browser transport is replaced. The CLI, benchmark page, tracing
// setup, metrics parser and readiness polling execute their production code.
function page() {
  const init = [];
  const handlers = [];
  globalThis.document = { querySelector: () => ({ width: 100, height: 100 }) };
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ info: { architecture: 'test-transport' } }) } },
  });
  return {
    on: (event, handler) => { if (event === 'console') handlers.push(handler); },
    addInitScript: async (fn, arg) => { init.push([fn, arg]); },
    goto: async () => {
      delete globalThis.__IFC_LITE_PERF_TRACE;
      delete globalThis.__IFC_LITE_LOAD_TRACE__;
      for (const [fn, arg] of init) fn(arg);
      assert.equal(globalThis.__IFC_LITE_PERF_TRACE, 1, 'CLI must enable tracing before viewer boot (#7032)');
    },
    waitForSelector: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => { await new Promise(resolve => setTimeout(resolve, 1)); },
    evaluate: async (fn, arg) => fn(arg),
    screenshot: async ({ path }) => { writeFileSync(path, 'test transport'); },
    locator: () => ({ first: () => ({ setInputFiles: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const names = ['parser.complete', 'geometry.streamComplete'];
      if (process.env.COLD_AB_FINALIZE !== 'missing') names.push('scene.finalize');
      const snapshot = {
        loadId: 'readiness-regression', attrs: {}, start: 0, end: 1,
        spans: names.map(name => ({ name, thread: 'main', start: 0, end: 1 })),
      };
      globalThis.__IFC_LITE_LOAD_TRACE__ = { latest: () => snapshot };
      // A completed load and allocated canvas alone must never pass a cold
      // sample whose renderer has not finalized, the original #7032 defect.
      for (const handler of handlers) handler({ text: () => '[ifc-lite] model.ifc (1.0MB) → 10 meshes, 100 verts in 0.1s' });
    } }) }),
  };
}

export const chromium = {
  executablePath: () => '/test/browser-transport',
  launch: async () => ({
    version: () => 'test-transport',
    newContext: async () => ({ newPage: async () => page(), close: async () => {} }),
    close: async () => {},
  }),
};
