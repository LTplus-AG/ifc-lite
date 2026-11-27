/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { useHardwareGpu } = await tsImport('../tests/e2e/gpu-browser.ts', import.meta.url);
const { ADAPTER_REQUEST_TIMEOUT_MS } = await tsImport('../packages/renderer/src/adapter-request.ts', import.meta.url);

function fakeBrowser(t, requestAdapter) {
  t.mock.getter(globalThis, 'navigator', () => ({ gpu: { requestAdapter } }));
  const events = [];
  const page = {
    route: async () => {},
    goto: async () => {},
    evaluate: async (probe) => probe(),
  };
  const context = {
    newPage: async () => page,
    close: async () => { events.push('context closed'); },
  };
  const browser = {
    newContext: async () => context,
    version: () => 'fixture',
    close: async () => { events.push('browser closed'); },
  };
  return { browser, events, use: async () => { events.push('used'); } };
}

test('#11345 CDP worker refuses software adapters and admits hardware', async (t) => {
  for (const [info, software] of [
    [{ vendor: 'Mesa', device: 'llvmpipe', isFallbackAdapter: false }, true],
    [{ vendor: 'Mesa', architecture: 'lavapipe', isFallbackAdapter: false }, true],
    [{ vendor: 'Microsoft', description: 'Microsoft Basic Render Driver', isFallbackAdapter: false }, true],
    [{ vendor: 'NVIDIA', isFallbackAdapter: true }, true],
    [{ vendor: 'NVIDIA', architecture: 'ampere', isFallbackAdapter: false }, false],
  ]) {
    await t.test(info.device ?? info.description ?? JSON.stringify(info), async (sub) => {
      const { browser, events, use } = fakeBrowser(sub, async () => ({ info }));
      const result = useHardwareGpu(browser, use);
      if (software) await assert.rejects(result, /no hardware WebGPU adapter/);
      else await result;
      assert.deepEqual(events, software ? ['context closed', 'browser closed'] : ['context closed', 'used', 'browser closed']);
    });
  }
});

test('#11345 a stalled CDP adapter request fails at the renderer deadline and closes the connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requested;
  const requestStarted = new Promise((resolve) => { requested = resolve; });
  const { browser, events, use } = fakeBrowser(t, () => {
    requested();
    return new Promise(() => {});
  });
  const result = useHardwareGpu(browser, use);
  await requestStarted;
  t.mock.timers.tick(ADAPTER_REQUEST_TIMEOUT_MS - 1);
  assert.deepEqual(events, []);
  t.mock.timers.tick(1);
  await assert.rejects(Promise.race([result, new Promise((resolve) => setImmediate(resolve))]), /GPU adapter request timed out/);
  assert.deepEqual(events, ['context closed', 'browser closed']);
});
