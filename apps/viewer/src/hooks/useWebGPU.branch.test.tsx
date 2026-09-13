/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A real user hit "WEBGPU NOT AVAILABLE", tried every browser, and got
 * nowhere. The likely cause: the page was loaded over plain HTTP on a
 * hostname/IP (not localhost), which makes `navigator.gpu` undefined in
 * EVERY browser — indistinguishable, from the old single-branch detector,
 * from "no browser on this device supports WebGPU". That misdiagnosis
 * handed the user GPU-blocklist flags that could never have helped.
 *
 * This test exercises both directions of the fix in `useWebGPU`:
 * - an insecure context with no `navigator.gpu` must be reported as
 *   'insecure-context', not blamed on the device.
 * - a secure context where `navigator.gpu` exists but adapter creation
 *   fails must still land on 'no-gpu' — the one category where the
 *   blocklist-override advice actually applies. A detector that always
 *   reports 'insecure-context' would pass a same-shaped test that only
 *   checked the first case, so both are asserted here.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWebGPU, type WebGPUStatus } from './useWebGPU.js';
import { webGpuBannerBlurb } from '@/components/viewer/WebGpuTroubleshooting.js';

function Probe({ onStatus }: { onStatus: (status: WebGPUStatus) => void }) {
  const status = useWebGPU();
  onStatus(status);
  return null;
}

async function renderProbe(): Promise<WebGPUStatus> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest!: WebGPUStatus;

  await act(async () => {
    root.render(<Probe onStatus={(s) => { latest = s; }} />);
    // Flush the async requestAdapter().then(...) microtask/effect tail
    // inside the same act() call so React never sees an update outside it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  act(() => {
    root.unmount();
  });
  container.remove();
  return latest;
}

const originalIsSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

function setNavigatorGpu(value: unknown) {
  Object.defineProperty(navigator, 'gpu', { value, configurable: true });
}

afterEach(() => {
  if (originalIsSecureContext) Object.defineProperty(window, 'isSecureContext', originalIsSecureContext);
  else Reflect.deleteProperty(window, 'isSecureContext');
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
});

describe('useWebGPU category detection', () => {
  it('reports insecure-context when navigator.gpu is missing on an insecure origin', async () => {
    setSecureContext(false);
    setNavigatorGpu(undefined);

    const status = await renderProbe();

    assert.equal(status.supported, false);
    assert.equal(status.category, 'insecure-context');
    assert.match(webGpuBannerBlurb(status.category), /secure connection/i);
    // Must NOT blame the device/browser for what is actually an origin problem.
    assert.doesNotMatch(webGpuBannerBlurb(status.category), /could not create a GPU adapter/i);
  });

  it('reports no-gpu when navigator.gpu exists in a secure context but adapter creation fails', async () => {
    setSecureContext(true);
    setNavigatorGpu({ requestAdapter: async () => null });

    const status = await renderProbe();

    assert.equal(status.supported, false);
    assert.equal(status.category, 'no-gpu');
    assert.match(webGpuBannerBlurb(status.category), /could not create a GPU adapter/i);
    // Must NOT tell a genuine hardware/driver case that its origin is the problem.
    assert.doesNotMatch(webGpuBannerBlurb(status.category), /secure connection/i);
  });
});
