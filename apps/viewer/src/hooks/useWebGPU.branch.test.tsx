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
import { useWebGpuOpenGuard, type WebGpuOpenGuard } from './useWebGpuOpenGuard.js';
import { webGpuBannerBlurb } from '@/components/viewer/WebGpuTroubleshooting.js';
import { useViewerStore } from '@/store';

function Probe({ onStatus }: { onStatus: (status: WebGPUStatus) => void }) {
  const status = useWebGPU();
  onStatus(status);
  return null;
}

function OpenProbe({ onGuard }: { onGuard: (guard: WebGpuOpenGuard['guard']) => void }) {
  onGuard(useWebGpuOpenGuard().guard);
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
  it('rechecks a failed adapter on explicit Retry and then opens the same source (#5851)', async () => {
    setSecureContext(true);
    let calls = 0;
    setNavigatorGpu({ requestAdapter: async () => ++calls === 1 ? null : {} });
    useViewerStore.getState().resetViewerState();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let guard!: WebGpuOpenGuard['guard'];
    let opened = 0;
    const attempt = () => { if (guard(attempt)) opened += 1; };
    try {
      await act(async () => {
        root.render(<OpenProbe onGuard={(next) => { guard = next; }} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      act(attempt);
      assert.equal(calls, 1);
      assert.equal(opened, 0);
      assert.equal(typeof useViewerStore.getState().lastLoadRetry, 'function');

      await act(async () => {
        useViewerStore.getState().lastLoadRetry?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(calls, 2, 'explicit Retry must recheck a failed adapter');
      assert.equal(opened, 1, 'the original source opens after WebGPU recovers');
    } finally {
      act(() => { root.unmount(); });
      container.remove();
      useViewerStore.setState({ error: null, lastLoadRetry: null });
    }
  });

  it('shares one adapter probe across viewport, URL and status consumers (#5851)', async () => {
    setSecureContext(true);
    let calls = 0;
    setNavigatorGpu({ requestAdapter: async () => { calls += 1; return {}; } });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const statuses: WebGPUStatus[] = [];
    try {
      await act(async () => {
        root.render(<>
          <Probe onStatus={(status) => { statuses[0] = status; }} />
          <Probe onStatus={(status) => { statuses[1] = status; }} />
          <Probe onStatus={(status) => { statuses[2] = status; }} />
        </>);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(calls, 1);
      assert.equal(statuses.length, 3);
      assert.ok(statuses.every((status) => status.supported));
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }

    assert.equal((await renderProbe()).supported, true);
    assert.equal(calls, 1, 'remounting another consumer must reuse the capability verdict');
  });

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
