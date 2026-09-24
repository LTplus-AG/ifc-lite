/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5388: #1360 added `Renderer.setOverlayLineColor` but the viewer never
// called it, so every overlay line channel (annotation, alignment, grid, DXF,
// LandXML) and the section-cut outline stayed black on the dark theme's
// near-black clear colour. The invariant: once the renderer is up, the line
// colour it holds clears 3:1 against the theme's backdrop, follows a theme
// switch, and the light theme keeps the renderer's black.
//
// Contrast is computed here rather than imported, so this file only enters
// production through the pre-existing `useRenderUpdates` seam.
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Renderer, VisualEnhancementOptions } from '@ifc-lite/renderer';
import type { SectionPlane } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { useRenderUpdates } from './useRenderUpdates.js';

afterEach(cleanup);

const BACKDROP = { light: [0.96, 0.96, 0.97], dark: [0.102, 0.106, 0.149] } as const;
function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every renderer call the hook can make on this path, recorded or ignored. */
function recordingRenderer() {
  const lineColors: number[][] = [];
  const renderer = new Proxy({}, {
    get: (_t, key) => key === 'setOverlayLineColor'
      ? (c: readonly number[]) => { lineColors.push([...c]); }
      : () => {},
  });
  return { lineColors, renderer: renderer as Renderer };
}

const SECTION: SectionPlane = { axis: 'down', position: 50, enabled: false, flipped: false } as SectionPlane;

function Probe({ renderer, theme }: { renderer: Renderer; theme: string }) {
  const ref = <T,>(v: T) => useRef(v);
  useRenderUpdates({
    rendererRef: ref<Renderer | null>(renderer), isInitialized: true, theme,
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    visualEnhancementRef: ref({} as VisualEnhancementOptions),
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    selectedEntityId: null, selectedEntityIds: undefined, selectedModelIndex: undefined,
    activeTool: 'select', sectionPlane: SECTION, sectionRange: null,
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref<Set<number> | null>(null),
    selectedEntityIdRef: ref<number | null>(null), selectedModelIndexRef: ref<number | undefined>(undefined),
    selectedEntityIdsRef: ref<Set<number> | undefined>(undefined), sectionPlaneRef: ref(SECTION),
    sectionRangeRef: ref<{ min: number; max: number } | null>(null), activeToolRef: ref('select'),
    drawing2D: null, show3DOverlay: false, showHiddenLines: false,
  });
  return null;
}

describe('useRenderUpdates overlay line ink (#5388)', () => {
  it('dark: the overlay line colour clears 3:1 against the dark clear colour', () => {
    const { lineColors, renderer } = recordingRenderer();
    render(<Probe renderer={renderer} theme="dark" />);
    const color = lineColors.at(-1);
    assert.ok(color, 'setOverlayLineColor was called');
    assert.ok(contrast(color, BACKDROP.dark) >= 3, `line ${JSON.stringify(color)} on dark`);
  });

  it('light keeps black, and a theme switch recolours the lines', () => {
    const { lineColors, renderer } = recordingRenderer();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<Probe renderer={renderer} theme="light" />));
    assert.deepEqual(lineColors.at(-1), [0, 0, 0, 1]);
    act(() => root.render(<Probe renderer={renderer} theme="dark" />));
    assert.ok(contrast(lineColors.at(-1)!, BACKDROP.dark) >= 3, 'switching to dark recolours the lines');
    act(() => root.unmount());
    container.remove();
  });
});
