/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embed's axis helper resolves real colours (#5490).
 *
 * `AxisHelper` paints with `var(--overlay-axis-*)`, and those properties were
 * written onto `<html>` only by a component the viewer's `App` mounted. The
 * embed renders the viewer's `ViewportOverlays` without that `App`, so every
 * `var()` resolved to nothing and the triad was transparent. The sync now
 * rides the store, so this renders the REAL embed (`ViewportOverlays` is not
 * mocked) and reads back the colour each arm, label and the origin dot
 * actually compute to, per theme the embed supports (`?theme=`).
 *
 * The `useWebGPU` mock is load-bearing for the reason
 * `EmbedViewer.overlays.test.ts` records: without it the overlays never render.
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
const { OVERLAY_PALETTES } = await import('@/lib/viewport-ui/overlay-theme');

const AXIS = '[data-testid="viewport-axis-helper"]';
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/** A computed colour as `#rrggbb`, whichever form the engine reports it in. */
function hex(colour: string): string {
  const value = colour.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
  if (!m) return value;
  return `#${m.slice(1, 4).map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
}

function renderEmbed(search: string): HTMLElement {
  window.history.replaceState({}, '', `/${search}`);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(EmbedViewer));
  });
  mounted.push({ root, container });
  return container;
}

/** The helper's parts, found by what they are rather than by position. */
function axisParts(container: HTMLElement) {
  const helper = container.querySelector<HTMLElement>(AXIS);
  expect(helper, 'the embed draws the axis helper by default').not.toBeNull();
  const divs = [...helper!.querySelectorAll<HTMLElement>('div')];
  const label = (text: string) => divs.find((d) => d.children.length === 0 && d.textContent?.trim() === text);
  const unlabelled = divs.filter((d) => d.children.length === 0 && !d.textContent?.trim());
  const vertical = unlabelled.find((d) => d.style.width === '2px' && d.style.height === '20px');
  const origin = unlabelled.find((d) => d.style.width === '8px' && d.style.height === '8px');
  return { x: label('X'), y: label('Y'), z: label('Z'), vertical, origin };
}

beforeEach(() => {
  useViewerStore.setState({ isMobile: false, selectedStoreys: new Set<number>() });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })));
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('EmbedViewer: the axis helper resolves the overlay tokens (#5490)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`?theme=${theme}: labels, the vertical arm and the origin dot compute to the ${theme} palette`, () => {
      const palette = OVERLAY_PALETTES[theme];
      const parts = axisParts(renderEmbed(`?theme=${theme}`));
      expect(parts.x && parts.y && parts.z && parts.vertical && parts.origin, 'every part is drawn').toBeTruthy();

      expect(hex(getComputedStyle(parts.x!).color)).toBe(palette['axis-x']);
      expect(hex(getComputedStyle(parts.y!).color)).toBe(palette['axis-y']);
      expect(hex(getComputedStyle(parts.z!).color)).toBe(palette['axis-z']);
      // IFC is Z-up: the helper's vertical arm is Z, and paints in axis-z.
      expect(hex(getComputedStyle(parts.vertical!).backgroundColor)).toBe(palette['axis-z']);
      expect(hex(getComputedStyle(parts.origin!).backgroundColor)).toBe(palette['overlay-halo']);
    });
  }
});
