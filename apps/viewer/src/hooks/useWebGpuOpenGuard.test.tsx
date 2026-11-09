/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The open guard's "WebGPU is still being checked" notice must move on when
 * the adapter probe settles, whatever the probe's answer and whatever locale
 * is active by then (G1). The transition used to be keyed on the notice's
 * translated text: a supported answer left "still being checked" up for good,
 * and a locale switch mid-probe broke the hand-over to "unsupported".
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { useViewerStore } from '@/store';
import { useWebGpuOpenGuard, type WebGpuOpenGuard } from './useWebGpuOpenGuard.js';

const CHECKING = 'viewportLighting.container.loadErrorCard.webgpuChecking';
const UNSUPPORTED = 'viewportLighting.container.loadErrorCard.webgpuUnsupported';
registerLocale('g1-pseudo', { [CHECKING]: '⟦checking⟧', [UNSUPPORTED]: '⟦unsupported⟧' });

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');

/** A fresh `navigator.gpu` whose adapter request settles when the test says so. */
function pendingAdapter(): (adapter: object | null) => void {
  let settle!: (adapter: object | null) => void;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'gpu', {
    value: { requestAdapter: () => new Promise<object | null>((resolve) => { settle = resolve; }) },
    configurable: true,
  });
  return (adapter) => settle(adapter);
}

let guard!: WebGpuOpenGuard['guard'];
function OpenProbe() {
  guard = useWebGpuOpenGuard().guard;
  return null;
}

async function settleProbe(settle: (adapter: object | null) => void, adapter: object | null) {
  await act(async () => { settle(adapter); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.getState().resetViewerState();
});
afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ error: null, lastLoadRetry: null });
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else Reflect.deleteProperty(window, 'isSecureContext');
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
});

describe('useWebGpuOpenGuard pending-probe notice (G1)', () => {
  it('a drop during the probe opens once the probe reports WebGPU supported, and the notice goes away', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    let opened = 0;
    const attempt = () => { if (guard(attempt)) opened += 1; };
    act(attempt);
    assert.equal(opened, 0);
    assert.equal(useViewerStore.getState().error, viewportLightingEn[CHECKING], 'the drop explains the pending check');

    await settleProbe(settle, {});
    assert.equal(useViewerStore.getState().error, null, '"still being checked" must not outlive the check');
    assert.equal(opened, 1, 'the dropped model opens once WebGPU turns out to be supported');
  });

  it('an open with no retry just clears the notice when the probe reports supported', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(); });
    assert.equal(useViewerStore.getState().error, viewportLightingEn[CHECKING]);
    await settleProbe(settle, {});
    assert.equal(useViewerStore.getState().error, null);
  });

  it('a locale switch while the probe is pending still hands over to "unsupported", in the new locale', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(() => {}); });
    assert.equal(useViewerStore.getState().error, viewportLightingEn[CHECKING]);

    act(() => setLocale('g1-pseudo'));
    assert.equal(useViewerStore.getState().error, '⟦checking⟧', 'the pending notice follows the locale');
    await settleProbe(settle, null);
    assert.equal(useViewerStore.getState().error, '⟦unsupported⟧');
    assert.equal(typeof useViewerStore.getState().lastLoadRetry, 'function', 'Retry survives the hand-over');
  });

  it('leaves a newer load error alone when the probe settles', async () => {
    const settle = pendingAdapter();
    render(<OpenProbe />);
    act(() => { guard(() => {}); });
    useViewerStore.setState({ error: 'newer load failed', lastLoadRetry: null });
    await settleProbe(settle, {});
    assert.equal(useViewerStore.getState().error, 'newer load failed');
  });
});
