/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `?autoLoad=false` was parsed and then ignored (#2934).
 *
 * `urlParams.test.ts` pins the PARSING of `autoLoad` thoroughly — absent is
 * `undefined`, `?autoLoad=false` is `false`, anything else is `true`. What
 * nothing asserted is whether the parsed value is ever *applied*, and it was
 * not: `EmbedViewer`'s auto-load effect guarded on `modelUrl`, WebGPU support
 * and `loading`, never on `autoLoad`, so a host that explicitly asked not to
 * load got the model anyway.
 *
 * That is the exact shape #2934 describes, and the reason the bug survived: a
 * tested parser feeding an untested application.
 *
 * TWO tests, and the second is the one that matters. `autoLoad` is
 * `boolean | undefined`, so the guard has to be `=== false`; the natural
 * `if (!urlParams.autoLoad) return` would ALSO suppress the default, breaking
 * every embed that omits the parameter — a far worse bug than the one being
 * fixed. The default-loads case pins that.
 *
 * `useWebGPU` is mocked as supported, and that mock is load-bearing. Under
 * happy-dom `navigator.gpu` is absent, so the real hook reports
 * `supported: false` and the auto-load effect returns before reaching the
 * `autoLoad` check at all. Measured with the mock removed: the two
 * must-still-load cases FAIL (fetch is never called), and the
 * `autoLoad=false` case passes for entirely the wrong reason. Without the two
 * positive cases, this file would look green while proving nothing.
 */

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/components/viewer/Viewport', () => ({ Viewport: () => null }));
vi.mock('@/components/viewer/ViewportOverlays', () => ({ ViewportOverlays: () => null }));

// happy-dom has no `navigator.gpu`; without this the effect under test is
// unreachable and every assertion here would be vacuous.
vi.mock('@/hooks/useWebGPU', () => ({
  useWebGPU: () => ({ supported: true, checking: false, reason: null }),
}));

const loadFile = vi.fn(async () => {});
vi.mock('@/hooks/useIfc', () => ({
  useIfc: () => ({
    geometryResult: null,
    ifcDataStore: null,
    loadFile,
    loading: false,
    models: new Map(),
    clearAllModels: vi.fn(),
    addModel: vi.fn(async () => 'stub-model-id'),
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { EmbedViewer } = await import('./EmbedViewer.js');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let fetchSpy: ReturnType<typeof vi.fn>;

/** `parseUrlParams()` runs once in a `useState` initialiser, so the search
 *  string has to be in place before the first render. */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

function renderEmbedViewer(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
}

/** Let the effect's async IIFE reach its first await. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  loadFile.mockClear();
  vi.unstubAllGlobals();
  setSearch('');
});

describe('EmbedViewer: the autoLoad URL parameter', () => {
  it('does not fetch the model when autoLoad=false', async () => {
    setSearch('?modelUrl=https%3A%2F%2Fcdn.example%2Fa.ifc&autoLoad=false');
    renderEmbedViewer();
    await settle();

    expect(fetchSpy, 'an explicit autoLoad=false must suppress the fetch').not.toHaveBeenCalled();
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('still auto-loads when autoLoad is absent — the default must not regress', async () => {
    // The case that catches an over-eager guard. `autoLoad` is undefined here,
    // and `undefined` is falsy: a `!urlParams.autoLoad` check would suppress
    // loading for every embed that never asked to.
    setSearch('?modelUrl=https%3A%2F%2Fcdn.example%2Fa.ifc');
    renderEmbedViewer();
    await settle();

    expect(fetchSpy, 'omitting autoLoad must keep the existing load behaviour').toHaveBeenCalled();
  });

  it('still auto-loads for any value other than the literal "false"', async () => {
    // Mirrors the parser's documented rule, which `urlParams.test.ts` pins:
    // `?autoLoad=0` is TRUE. A guard written against truthiness of the string
    // rather than the parsed boolean would get this backwards.
    setSearch('?modelUrl=https%3A%2F%2Fcdn.example%2Fa.ifc&autoLoad=0');
    renderEmbedViewer();
    await settle();

    expect(fetchSpy).toHaveBeenCalled();
  });
});
