/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5851 — `?model=<URL>` autoload used to fail with `console.error` only, so
 * a malformed URL, a cross-origin URL, or a failed fetch left the user
 * looking at an empty viewer with no explanation. Each now sets the store's
 * `error` (through the shared `showLoadError` helper), so the in-viewport
 * load-error card shows it.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useModelUrlAutoload } from './useModelUrlAutoload.js';

function setModelParam(value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete('model');
  else url.searchParams.set('model', value);
  window.history.replaceState(null, '', url.toString());
}

let restoreGpu: (() => void) | null = null;
function stubWebGpuSupported(): void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) },
  });
  restoreGpu = () => {
    if (original) Object.defineProperty(navigator, 'gpu', original);
    else Reflect.deleteProperty(navigator, 'gpu');
  };
}

let originalFetch: typeof fetch;

function Probe(): null {
  useModelUrlAutoload();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  stubWebGpuSupported();
  useViewerStore.getState().resetViewerState();
  useViewerStore.setState({ error: null, lastLoadRetry: null });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  globalThis.fetch = originalFetch;
  restoreGpu?.();
  restoreGpu = null;
  setModelParam(null);
  useViewerStore.setState({ error: null, lastLoadRetry: null });
});

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
}

describe('?model= autoload (#5851)', () => {
  it('a fetch failure sets the store error, with a Retry closure ready', async () => {
    setModelParam('model.ifc');
    const originalLocation = window.location.href;
    const source = new URL('model.ifc', originalLocation).href;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;

    mount();

    await waitFor(() => useViewerStore.getState().error !== null, 'the ?model= fetch failure sets store error');
    assert.match(useViewerStore.getState().error ?? '', /could not be downloaded/i);
    assert.equal(typeof useViewerStore.getState().lastLoadRetry, 'function');
    try {
      window.history.pushState(null, '', '/different/path/');
      useViewerStore.getState().lastLoadRetry?.();
      await waitFor(() => requestedUrls.length === 2, 'Retry fetches the same model URL');
      assert.deepEqual(requestedUrls, [source, source]);
    } finally {
      window.history.replaceState(null, '', originalLocation);
    }
  });

  it('pins a relative source before WebGPU refusal, then retries it after navigation (#5851)', async () => {
    let adapterCalls = 0;
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ++adapterCalls === 1 ? null : {} },
    });
    setModelParam('model.ifc');
    const originalLocation = window.location.href;
    const source = new URL('model.ifc', originalLocation).href;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;

    mount();
    await waitFor(() => useViewerStore.getState().lastLoadRetry !== null, 'WebGPU refusal offers Retry');
    assert.equal(requestedUrls.length, 0);
    try {
      window.history.pushState(null, '', '/different/path/');
      await act(async () => {
        useViewerStore.getState().lastLoadRetry?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => requestedUrls.length === 1, 'WebGPU Retry fetches the original source');
      assert.deepEqual(requestedUrls, [source]);
      assert.equal(adapterCalls, 2);
    } finally {
      window.history.replaceState(null, '', originalLocation);
    }
  });

  it('keeps the first relative source when navigation happens during the adapter probe (#5851)', async () => {
    let resolveAdapter: ((value: object) => void) | undefined;
    const adapter = new Promise<object>((resolve) => { resolveAdapter = resolve; });
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: () => adapter },
    });
    setModelParam('model.ifc');
    const originalLocation = window.location.href;
    const source = new URL('model.ifc', originalLocation).href;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }) as typeof fetch;

    mount();
    await waitFor(() => resolveAdapter !== undefined, 'the WebGPU adapter probe starts');
    assert.equal(requestedUrls.length, 0);
    try {
      window.history.pushState(null, '', '/different/path/');
      await act(async () => {
        resolveAdapter?.({});
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => requestedUrls.length === 1, 'autoload fetches the original source');
      assert.deepEqual(requestedUrls, [source]);
    } finally {
      window.history.replaceState(null, '', originalLocation);
    }
  });

  it('a cross-origin URL is refused and reported, never fetched', async () => {
    let fetchCalls = 0;
    setModelParam('https://attacker.example/model.ifc');
    globalThis.fetch = (async () => { fetchCalls += 1; return new Response(); }) as typeof fetch;

    mount();

    await waitFor(() => useViewerStore.getState().error !== null, 'a cross-origin ?model= is reported');
    assert.equal(fetchCalls, 0, 'a cross-origin URL must never be fetched');
    assert.match(useViewerStore.getState().error ?? '', /different site/i);
  });

  it('does nothing when ?model= is absent', async () => {
    setModelParam(null);
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls += 1; return new Response(); }) as typeof fetch;

    mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });

    assert.equal(fetchCalls, 0);
    assert.equal(useViewerStore.getState().error, null);
  });
});
