/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `?hideAxis=` and `?hideScale=` were parsed by the embed and then never read
 * (#2934 item 5). `urlParams.test.ts` pins the PARSING; a `grep` for
 * `urlParams.hideAxis` / `.hideScale` across `apps/viewer-embed` matched only
 * the parser and its own test, and `ViewportOverlays` took a single
 * `hideViewCube` prop, rendering the axis helper and the scale readout
 * unconditionally.
 *
 * `hideViewCube` — the fourth sibling, and the one that WAS wired — is the
 * pattern followed here: a prop on `ViewportOverlays` guarding the JSX, passed
 * from `EmbedViewer`'s single `<ViewportOverlays />` call site.
 *
 * These render the REAL `ViewportOverlays` (deliberately NOT mocked out, as
 * the sibling `EmbedViewer.urlParams.test.ts` does) and assert on the DOM the
 * embed actually produces. Both directions are asserted for each param: a test
 * that only checked the hidden case would pass an implementation that hides
 * the overlay always, so every case also asserts the OTHER overlay is still
 * there, and the no-param case asserts both are.
 *
 * The `useWebGPU` mock is load-bearing for the reason `EmbedViewer.autoLoad.test.ts`
 * records: happy-dom has no `navigator.gpu`, so without it the whole
 * `Viewport`/`ViewportOverlays` subtree is never rendered and every "absent"
 * assertion below would be vacuously true. The default-case test is the guard
 * that would catch that regressing.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/components/viewer/Viewport', () => ({ Viewport: () => null }));

vi.mock('@/hooks/useWebGPU', () => ({
  useWebGPU: () => ({ supported: true, checking: false, reason: null }),
}));

vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => ({
    geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0 },
    ifcDataStore: null,
    loadFile: vi.fn(async () => {}),
    loading: false,
    models: new Map(),
    clearAllModels: vi.fn(),
    addModel: vi.fn(async () => 'stub-model-id'),
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');
const { useViewerStore } = await import('@/store');

const AXIS = '[data-testid="viewport-axis-helper"]';
const SCALE = '[data-testid="viewport-scale-readout"]';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** `parseUrlParams()` runs in a `useState` initialiser — set the search first. */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

function renderEmbedViewer(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  // The axis helper and the scale readout live inside a `!isMobile` branch of
  // `ViewportOverlays`; a mobile store would make every "absent" assertion
  // below pass for the wrong reason.
  useViewerStore.setState({ isMobile: false, selectedStoreys: new Set<number>() });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  setSearch('');
});

describe('EmbedViewer: ?hideAxis= / ?hideScale=', () => {
  it('draws both the axis helper and the scale readout when neither param is set', () => {
    setSearch('');
    const container = renderEmbedViewer();

    expect(container.querySelector(AXIS)).not.toBeNull();
    expect(container.querySelector(SCALE)).not.toBeNull();
  });

  it('removes the axis helper for ?hideAxis=true, and nothing else', () => {
    setSearch('?hideAxis=true');
    const container = renderEmbedViewer();

    expect(container.querySelector(AXIS)).toBeNull();
    expect(container.querySelector(SCALE)).not.toBeNull();
  });

  it('removes the scale readout for ?hideScale=true, and nothing else', () => {
    setSearch('?hideScale=true');
    const container = renderEmbedViewer();

    expect(container.querySelector(SCALE)).toBeNull();
    expect(container.querySelector(AXIS)).not.toBeNull();
  });

  it('removes both when both params are set', () => {
    setSearch('?hideAxis=true&hideScale=true');
    const container = renderEmbedViewer();

    expect(container.querySelector(AXIS)).toBeNull();
    expect(container.querySelector(SCALE)).toBeNull();
  });

  it('keeps both when the params are present but not "true"', () => {
    // `parseUrlParams` only sets the flag for the exact string "true"; this
    // pins that the render path agrees rather than treating any value as set.
    setSearch('?hideAxis=false&hideScale=0');
    const container = renderEmbedViewer();

    expect(container.querySelector(AXIS)).not.toBeNull();
    expect(container.querySelector(SCALE)).not.toBeNull();
  });
});
