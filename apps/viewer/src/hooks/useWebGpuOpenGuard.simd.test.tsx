/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10784: a browser without WebAssembly SIMD cannot compile the engine binary.
 * The open guard must refuse before any load starts, with the translated
 * explanation, instead of letting the CompileError reach the user raw.
 * `WebAssembly.validate` is stubbed to reject the SIMD probe, which is what
 * such a browser does.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { useViewerStore } from '@/store';
import { useWebGpuOpenGuard, type WebGpuOpenGuard } from './useWebGpuOpenGuard.js';
import { retryWebGPU } from './useWebGPU.js';

const SIMD_UNSUPPORTED = viewportLightingEn['viewportLighting.container.loadErrorCard.wasmSimdUnsupported'];

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');

let guard!: WebGpuOpenGuard['guard'];
function OpenProbe() {
  guard = useWebGpuOpenGuard().guard;
  return null;
}

beforeEach(async () => {
  setLocale('en');
  useViewerStore.getState().resetViewerState();
  // A browser with a working WebGPU adapter: SIMD is the only thing missing.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
  await retryWebGPU();
});
afterEach(() => {
  mock.restoreAll();
  cleanup();
  useViewerStore.setState({ error: null, lastLoadRetry: null });
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else Reflect.deleteProperty(window, 'isSecureContext');
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
});

describe('useWebGpuOpenGuard without WebAssembly SIMD (#10784)', () => {
  it('refuses the open and shows the SIMD card, with no Retry', () => {
    render(<OpenProbe />);
    mock.method(WebAssembly, 'validate', () => false);
    let opened = 0;
    const attempt = () => { if (guard(attempt, { replay: 'free' })) opened += 1; };
    act(attempt);
    assert.equal(opened, 0, 'no load may start: it would only compile the binary and fail');
    const { error, lastLoadRetry } = useViewerStore.getState();
    assert.equal(error, SIMD_UNSUPPORTED);
    assert.equal(lastLoadRetry, null, 'a retry cannot add SIMD to the browser');
  });

  it('lets the same open through when the probe validates', () => {
    render(<OpenProbe />);
    let opened = 0;
    act(() => { if (guard()) opened += 1; });
    assert.equal(opened, 1);
    assert.equal(useViewerStore.getState().error, null);
  });
});
