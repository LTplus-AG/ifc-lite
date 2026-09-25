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
import { AnnotationPin } from './annotations/AnnotationPin';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../..');

let sheet: HTMLStyleElement | null = null;

before(async () => {
  // Tailwind scans the component sources for the classes they use, exactly as
  // the Vite build does, so a class the components stop using drops out here too.
  const input = `@import "./index.css";\n@source "./components/viewer/RectSelectionOverlay.tsx";\n@source "./components/viewer/annotations/AnnotationPin.tsx";\n`;
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
      const ui = render(<RectSelectionOverlay rect={{ x0: 10, y0: 10, x1: 120, y1: 80 }} />);
      const rect = ui.querySelector('rect');
      assert.ok(rect, 'marquee rendered');
      const stroke = getComputedStyle(rect).stroke;
      assert.deepEqual(asLinear(stroke), gpuSelection(theme));
    });

    it(`${theme}: a selected annotation pin rings in the GPU selection colour`, () => {
      mountTheme(theme);
      const ui = render(<AnnotationPin index={1} selected />);
      const ring = ui.querySelector('button > span:last-child');
      assert.ok(ring, 'selection ring rendered');
      const ringColour = getComputedStyle(ring).getPropertyValue('--tw-ring-color');
      assert.deepEqual(asLinear(ringColour), gpuSelection(theme));
    });
  }

  it('a committed pin is ink and the draft pin is the accent, never amber', () => {
    mountTheme('light');
    const ui = render(
      <>
        <AnnotationPin index={1} />
        <AnnotationPin index={2} variant="draft" />
      </>,
    );
    const [idle, draft] = [...ui.querySelectorAll('button > span:first-child')].map(
      (dot) => getComputedStyle(dot).backgroundColor.trim(),
    );
    assert.equal(idle, OVERLAY_PALETTES.light['overlay-ink']);
    assert.equal(draft, OVERLAY_PALETTES.light['overlay-accent']);
  });
});

