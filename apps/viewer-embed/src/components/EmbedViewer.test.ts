/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StrictMode bridge teardown regression test — through the real call site.
 *
 * `lifecycle.test.ts` pins `mountBridgeLifecycle`/`unmountBridgeLifecycle` in
 * isolation, hand-wired around the real `initBridge`/`destroyBridge`. That
 * proves the helper is correct, but it never imports `EmbedViewer.tsx`, so a
 * revert of the ONE load-bearing line in `EmbedViewer.tsx` (the cleanup
 * calling `unmountBridgeLifecycle` instead of `destroyBridge()` directly)
 * would not fail any existing test.
 *
 * This test renders the REAL `EmbedViewer` component (via `react-dom/client`,
 * under `React.StrictMode`, in a `happy-dom` environment) and asserts that
 * after StrictMode's dev-only mount -> cleanup -> mount cycle, the postMessage
 * bridge is still alive and answers an inbound command. `Viewport` /
 * `ViewportOverlays` (WebGPU/renderer-heavy) and `useIfc` (WASM parser/worker
 * heavy) are mocked -- they are not what this regression is about -- but the
 * bridge-init effect in `EmbedViewer.tsx` itself is not.
 *
 * This is a `.ts` file, not `.tsx`, using `React.createElement` throughout:
 * this package's vitest `include` glob is `src/**\/*.test.ts` only. That
 * does not stop a `.ts` test from importing and rendering a `.tsx` module —
 * the file's own extension only gates what vitest *collects*, not what it
 * can *import*.
 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';

// Heavy/renderer-dependent children: not what this regression is about, and
// their real implementations pull in WebGPU/three.js machinery `happy-dom`
// cannot provide. Stub them out so the bridge-init effect is what's under test.
vi.mock('@/components/viewer/Viewport', () => ({
  Viewport: () => null,
}));
vi.mock('@/components/viewer/ViewportOverlays', () => ({
  ViewportOverlays: () => null,
}));

// `useIfc` composes useIfcLoader/useIfcFederation, which pull in the WASM
// parser and worker machinery — real for the app, irrelevant to whether the
// bridge survives a StrictMode remount. Stub with stable function identities
// so the bridge effect's dependency array doesn't churn across renders.
const loadFile = vi.fn(async () => {});
const addModel = vi.fn(async () => 'stub-model-id');
vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => ({
    geometryResult: null,
    ifcDataStore: null,
    loadFile,
    loading: false,
    models: new Map(),
    clearAllModels: vi.fn(),
    addModel,
  }),
}));

// React 19's act() requires the environment to opt in explicitly (same as
// apps/viewer's src/test/setup-dom.ts); without this every act() call warns
// and updates are not guaranteed to be flushed synchronously.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');
const { useViewerStore } = await import('@/store/index.js');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderEmbedViewer(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(React.StrictMode, null, React.createElement(EmbedViewer)));
  });
  mounted.push({ root, container });
  return container;
}

function dispatchInbound(msg: { type: string; data?: unknown; requestId?: string }) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: EMBED_SOURCE, version: PROTOCOL_VERSION, ...msg },
        origin: 'https://parent.example',
        source: window.parent,
      }),
    );
  });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  loadFile.mockClear();
  addModel.mockClear();
});

describe('EmbedViewer: postMessage bridge survives React.StrictMode', () => {
  it('answers an inbound SET_THEME command after the dev-only mount -> cleanup -> mount cycle', () => {
    renderEmbedViewer();

    // EmbedViewer's own mount effect applies the URL theme (default 'light')
    // first; confirm that baseline so the assertion below is attributable to
    // the inbound command, not to mount-time initialization.
    expect(useViewerStore.getState().theme).toBe('light');

    // If the bridge were left dead by an un-reset StrictMode guard (the bug
    // this component's effect exists to fix), `onMessage` bails on
    // `if (!ctx) return` and this command is silently dropped.
    dispatchInbound({ type: 'SET_THEME', data: { theme: 'dark' } });

    expect(useViewerStore.getState().theme).toBe('dark');
  });
});
