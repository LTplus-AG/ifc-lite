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
import type { EmbedMessageEnvelope } from '@ifc-lite/embed-protocol';
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

/**
 * SET_THEME's `bg` field (packages/embed-protocol) is sent by the SDK
 * (embed-sdk's `setTheme(theme, bg)`) but, before this fix, was read into
 * handler.ts's `case 'SET_THEME'` payload and never applied anywhere. The
 * capability itself already existed via the `?bg=` URL param, which drives
 * `customBg` in EmbedViewer.tsx's root `<div>` background style -- this test
 * proves the runtime SET_THEME path now reaches that same rendered style,
 * not just that some function got called.
 */
describe('EmbedViewer: SET_THEME bg overrides the rendered background', () => {
  it('applies bg from a runtime SET_THEME command to the root div background', () => {
    const container = renderEmbedViewer();
    const root = container.firstElementChild as HTMLElement;

    // Baseline: light theme's default background, no custom bg yet.
    expect(root.style.background).toContain('#ffffff');

    dispatchInbound({ type: 'SET_THEME', data: { theme: 'light', bg: '112233' } });

    expect(root.style.background).toContain('#112233');
  });

  it('a later SET_THEME without bg does not clear a previously-set background', () => {
    const container = renderEmbedViewer();
    const root = container.firstElementChild as HTMLElement;

    dispatchInbound({ type: 'SET_THEME', data: { theme: 'light', bg: 'aabbcc' } });
    expect(root.style.background).toContain('#aabbcc');

    dispatchInbound({ type: 'SET_THEME', data: { theme: 'dark' } });
    expect(root.style.background).toContain('#aabbcc');
  });
});

/**
 * SECTION_CHANGED is a declared OutboundEventType (packages/embed-protocol)
 * that packages/embed-sdk exposes to host pages as 'section-changed'. The
 * SDK's own test (events-lifecycle.test.ts) only proves the SDK's listener
 * plumbing works by having the SDK fabricate the event itself -- it cannot
 * prove the viewer ever sends it. This test drives the REAL bridge handler
 * (apps/viewer-embed/src/bridge/handler.ts) through the real EmbedViewer
 * component and observes what actually gets posted to window.parent, the
 * same instrument the StrictMode test above uses for SET_THEME.
 */
describe('EmbedViewer: SET_SECTION emits SECTION_CHANGED to the parent', () => {
  it('posts SECTION_CHANGED (matching the CAMERA_CHANGED/ENTITY_SELECTED pattern) after SET_SECTION', () => {
    // handler.ts's SET_SECTION case never calls emitEvent itself -- it only
    // mutates the store (same as SET_CAMERA/SELECT). The corresponding
    // outbound event is produced reactively, by a useEffect in EmbedViewer.tsx
    // subscribed to the relevant store slice -- exactly how CAMERA_CHANGED and
    // ENTITY_SELECTED are produced from SET_CAMERA/SELECT. Capturing what
    // reaches window.parent.postMessage is therefore the only way to observe
    // this, hence overriding window.parent here (the FakeWindow harness in
    // handler.test.ts does the same, just for a hand-built `window` rather
    // than happy-dom's).
    const posted: EmbedMessageEnvelope[] = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (msg: EmbedMessageEnvelope) => posted.push(msg) },
    });

    renderEmbedViewer();

    dispatchInbound({ type: 'SET_SECTION', data: { enabled: true }, requestId: 'r1' });

    const types = posted.map((m) => m.type);
    // RESPONSE for the command must precede the reactive SECTION_CHANGED --
    // same ordering CAMERA_CHANGED/ENTITY_SELECTED use relative to their
    // triggering command's RESPONSE (posted synchronously in handler.ts,
    // versus the event which fires from React's next effect pass).
    expect(types.indexOf('RESPONSE')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('SECTION_CHANGED')).toBeGreaterThan(types.indexOf('RESPONSE'));

    const sectionChanged = posted.find((m) => m.type === 'SECTION_CHANGED');
    expect(sectionChanged?.data).toEqual({
      axis: useViewerStore.getState().sectionPlane.axis,
      position: useViewerStore.getState().sectionPlane.position,
      enabled: true,
    });
  });
});

/**
 * ENTITY_HOVERED is a declared OutboundEventType with SDK listener plumbing
 * and SDK tests — and, before #2934, zero `emitEvent('ENTITY_HOVERED', ...)`
 * call sites anywhere in this app. The SDK's tests pass because they call
 * `harness.emit('ENTITY_HOVERED', ...)` themselves, which proves the SDK
 * dispatches an event the viewer never sent.
 *
 * The viewer's hover pipeline is: pointermove -> throttled `renderer.pick()`
 * -> `setHoverState(...)` (apps/viewer/src/components/viewer/useMouseControls.ts
 * ~703), with that whole branch gated on `hoverTooltipsEnabled`. These tests
 * enter at `setHoverState` — the store action the pick path calls — and assert
 * what reaches `window.parent.postMessage`, covering both remaining links: the
 * gate the embed has to force on, and the emit. Driving `renderer.pick()`
 * itself needs a real WebGPU device and is out of reach here.
 */
describe('EmbedViewer: emits ENTITY_HOVERED from the viewer hover pipeline', () => {
  afterEach(() => {
    useViewerStore.getState().clearHover();
  });

  it('forces hoverTooltipsEnabled on, without which the pick path never runs', () => {
    // Defaults to false (UI_DEFAULTS.HOVER_TOOLTIPS_ENABLED) — a main-viewer
    // toolbar toggle the embed has no chrome to offer.
    useViewerStore.setState({ hoverTooltipsEnabled: false });

    renderEmbedViewer();

    expect(useViewerStore.getState().hoverTooltipsEnabled).toBe(true);
  });

  it('posts ENTITY_HOVERED to the parent when the pick path reports a hovered entity', () => {
    const posted: EmbedMessageEnvelope[] = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (msg: EmbedMessageEnvelope) => posted.push(msg) },
    });

    renderEmbedViewer();
    // emitToParent withholds every non-READY message until a concrete
    // parentOrigin is captured from a real inbound message — establish that
    // first, same as the SET_SECTION test above.
    dispatchInbound({ type: 'SET_THEME', data: { theme: 'light' } });

    act(() => {
      // Exactly what useMouseControls does with a pick hit.
      useViewerStore.getState().setHoverState({ entityId: 42, screenX: 10, screenY: 20 });
    });

    const hovered = posted.find((m) => m.type === 'ENTITY_HOVERED');
    expect(hovered?.data).toEqual({ id: 42, globalId: undefined, ifcType: undefined });
  });

  it('does not re-post for the same entity as the pointer drifts across it', () => {
    const posted: EmbedMessageEnvelope[] = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (msg: EmbedMessageEnvelope) => posted.push(msg) },
    });

    renderEmbedViewer();
    dispatchInbound({ type: 'SET_THEME', data: { theme: 'light' } });

    act(() => {
      useViewerStore.getState().setHoverState({ entityId: 42, screenX: 10, screenY: 20 });
    });
    act(() => {
      // Same entity, new screen position — every throttled mousemove within
      // one mesh produces this.
      useViewerStore.getState().setHoverState({ entityId: 42, screenX: 11, screenY: 21 });
    });

    expect(posted.filter((m) => m.type === 'ENTITY_HOVERED').length).toBe(1);
  });

  it('posts again once the pointer moves onto a different entity', () => {
    const posted: EmbedMessageEnvelope[] = [];
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: (msg: EmbedMessageEnvelope) => posted.push(msg) },
    });

    renderEmbedViewer();
    dispatchInbound({ type: 'SET_THEME', data: { theme: 'light' } });

    act(() => {
      useViewerStore.getState().setHoverState({ entityId: 42, screenX: 10, screenY: 20 });
    });
    act(() => {
      useViewerStore.getState().setHoverState({ entityId: 43, screenX: 30, screenY: 40 });
    });

    expect(posted.filter((m) => m.type === 'ENTITY_HOVERED').map((m) => (m.data as { id: number }).id))
      .toEqual([42, 43]);
  });
});
