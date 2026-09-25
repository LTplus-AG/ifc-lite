/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One selected colour across GPU and DOM (#5491, charter #5478).
 *
 * The renderer tints selected meshes with `rendererOverlayTheme(theme).selection`
 * (#5484). Before this change the DOM drew "selected" in three other hues: a
 * teal rectangle-select marquee, an emerald ring on a selected annotation pin
 * and a teal reposition marker; annotations themselves were amber. Here the
 * real components are mounted under the real stylesheet (the app's
 * `index.css`, compiled by the Tailwind v4 plugin chain), the theme is
 * published by the real `OverlayThemeSync`, and the colour each one actually
 * resolves to is compared with what the GPU gets, per theme.
 *
 * Annotation pins moved onto the shared `Pin` scene primitive (#5511) — a
 * selected/draft pin no longer draws a separate ring, it fills in the same
 * `overlay-accent` token every other "being manipulated" primitive uses, so
 * the pin cases below assert the projected `Pin`'s fill directly.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { useViewerStore } from '@/store';
import type { ThemeMode } from '@/store/slices/uiSlice';
import { cleanup, render } from '@/test/render.js';
import { OverlayThemeSync } from '@/components/viewport-ui/OverlayThemeSync';
import { OVERLAY_PALETTES, OVERLAY_TOKENS, overlayCssVar, tokenToLinearRgba } from '@/lib/viewport-ui/overlay-theme';
import { rendererOverlayTheme } from '@/lib/viewport-ui/overlay-theme-renderer';
import { RectSelectionOverlay } from './RectSelectionOverlay';
import { Pin } from '@/components/viewport-ui/scene';
import { renderScene } from '@/components/viewport-ui/scene/test/scene-test-support';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../..');

let sheet: HTMLStyleElement | null = null;

before(async () => {
  // Tailwind scans the component sources for the classes they use, exactly as
  // the Vite build does, so a class the components stop using drops out here too.
  const input = `@import "./index.css";\n@source "./components/viewer/RectSelectionOverlay.tsx";\n@source "./components/viewport-ui/scene/primitives/Pin.tsx";\n`;
  const result = await postcss([tailwindcss()]).process(input, { from: join(SRC, 'selection-accent.probe.css'), to: undefined });
  // happy-dom drops every rule inside `@layer`, so unwrap the layers in place.
  // Tailwind emits them in cascade order (theme, base, components,
  // utilities), so source order keeps the same winner for these rules.
  const root = postcss.parse(result.css);
  root.walkAtRules('layer', (layer) => {
    if (layer.nodes) layer.replaceWith(layer.nodes);
    else layer.remove();
  });
  sheet = document.createElement('style');
  sheet.textContent = root.toString();
  document.head.appendChild(sheet);
});

after(() => {
  sheet?.remove();
});

afterEach(() => {
  cleanup();
  for (const token of OVERLAY_TOKENS) document.documentElement.style.removeProperty(overlayCssVar(token));
});

function mountTheme(theme: ThemeMode): void {
  useViewerStore.setState({ theme });
  render(<OverlayThemeSync />);
}

/** The GPU's selection tint, as linear RGBA rounded for comparison. */
function gpuSelection(theme: ThemeMode): number[] {
  return rendererOverlayTheme(theme).selection.map((c) => Number(c.toFixed(4)));
}

function asLinear(cssColour: string): number[] {
  return tokenToLinearRgba(cssColour.trim()).map((c) => Number(c.toFixed(4)));
}

const THEMES: ThemeMode[] = ['light', 'dark', 'colorful'];

describe('one selection accent across GPU and DOM (#5491)', () => {
  for (const theme of THEMES) {
    it(`${theme}: the rectangle-select marquee strokes in the GPU selection colour`, () => {
      mountTheme(theme);
      // The marquee portals into the scene kernel's SVG layer (#6016), so it
      // needs the scene host mounted, like the pin case below.
      const { container } = renderScene(<RectSelectionOverlay rect={{ x0: 10, y0: 10, x1: 120, y1: 80 }} />);
      const rect = container.querySelector('[data-scene-primitive="rect-selection"]');
      assert.ok(rect, 'marquee rendered');
      const stroke = getComputedStyle(rect).stroke;
      assert.deepEqual(asLinear(stroke), gpuSelection(theme));
    });

    it(`${theme}: a selected annotation pin fills in the GPU selection colour`, () => {
      mountTheme(theme);
      const { container, flush } = renderScene(<Pin worldPoint={{ x: 0, y: 0, z: 0 }} active />);
      flush();
      const path = container.querySelector('[data-scene-primitive="pin"] path');
      assert.ok(path, 'pin rendered');
      const fill = getComputedStyle(path).fill;
      assert.deepEqual(asLinear(fill), gpuSelection(theme));
    });
  }

  it('a committed pin is ink and the draft pin is the accent, never amber', () => {
    mountTheme('light');
    const { container, flush } = renderScene(
      <>
        <Pin worldPoint={{ x: 0, y: 0, z: 0 }} />
        <Pin worldPoint={{ x: 10, y: 10, z: 0 }} active />
      </>,
    );
    flush();
    const [idle, draft] = [...container.querySelectorAll('[data-scene-primitive="pin"] path')].map(
      (path) => getComputedStyle(path).fill.trim(),
    );
    assert.equal(idle, OVERLAY_PALETTES.light['overlay-ink']);
    assert.equal(draft, OVERLAY_PALETTES.light['overlay-accent']);
  });
});

