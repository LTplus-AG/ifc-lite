/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measures the contrast of text a MOUNTED component actually renders (#6205).
 *
 * The earlier panel table (`panel-secondary-text.test.ts`) pulled class strings
 * out of TSX source by text anchor and measured those strings on a surface the
 * table guessed. That certified a string, not the rendered state: the class
 * could stop reaching the claimed text (a JSX restructure, a wrapper that
 * overrides colour, an inherited ancestor colour) and the row stayed green.
 *
 * This measures the element instead. A test mounts the real component in the
 * claimed state (happy-dom, store seeded like any viewer component test),
 * snapshots the rendered DOM with {@link snapshotRenderedDom}, and hands it to
 * {@link measureRenderedText} together with the user-visible strings it claims.
 * In real Chrome with the compiled app CSS (`render-harness.ts`) every visible
 * element whose OWN text (its direct text nodes, whitespace-collapsed) matches
 * a string is located by that TEXT, not by a selector or class, so the
 * measurement follows the text wherever the JSX puts it. For each hit:
 *
 * - text colour = the element's computed `color` (inherited or own), with its
 *   alpha multiplied by every ancestor's computed `opacity`;
 * - surface = every ancestor's computed `background-color`, from `<html>` down
 *   to the text's element, composited in paint order onto the white canvas.
 *   Glass surfaces (`.colorful .bg-background` is 48% white) therefore blend
 *   with the ancestors beneath them instead of being treated as opaque.
 *   Known limit: a NON-ancestor layer painted underneath (a modal's
 *   `bg-black/80` overlay sibling under a translucent dialog) is not
 *   composited. Hit-testing (`elementsFromPoint`) was tried and rejected: it
 *   depends on the snapshot's layout (an ancestor whose box a child overflows
 *   drops out of the stack), which made results layout-dependent.
 *
 * Animations and transitions are disabled so an enter fade is measured at its
 * settled state, never mid-fade.
 *
 * Colours are composited by a real `<canvas>` ("source-over") so OKLCH/OKLAB
 * and `color-mix()` values Tailwind v4 emits resolve exactly as Chrome paints
 * them. The ancestor-opacity product is applied to the text only (a faded
 * container also fades its own background); that approximation can only
 * UNDER-state contrast when a faded ancestor paints a background, so it never
 * hides a failure.
 */

import assert from 'node:assert/strict';
import { withThemedPage, type Theme } from './render-harness';
import { contrastRatio } from './wcag';

export const THEMES: readonly Theme[] = ['light', 'dark', 'colorful'];

/** The viewer shell every docked side panel sits in: `ViewerLayout`'s root
 *  `<div>` (`bg-background text-foreground`). Wrap a mounted panel body in it
 *  when the panel's own markup paints no background. */
export const VIEWER_SHELL_SURFACE = 'bg-background text-foreground';

/** One measured occurrence of a claimed string. */
export interface RenderedTextMeasurement {
  text: string;
  ratio: number;
  /** The painting element's class, for failure messages only. */
  className: string;
}

type WireMatcher = { exact: string } | { source: string; flags: string };

function toWire(matcher: string | RegExp): WireMatcher {
  return typeof matcher === 'string' ? { exact: matcher } : { source: matcher.source, flags: matcher.flags };
}

/** An element's OWN text: its direct text-node children joined, whitespace
 *  collapsed. Exactly the glyphs this element paints with its computed colour. */
function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((c) => c.nodeType === 3)
    .map((c) => c.textContent ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Snapshot the DOM a test mounted (everything under `document.body`, so Radix
 * portals are included), optionally wrapped in the panel surface the component
 * is hosted on when that ancestor lives outside the mounted subtree.
 */
export function snapshotRenderedDom(hostSurfaceClassName?: string): string {
  const html = document.body.innerHTML;
  return hostSurfaceClassName === undefined ? html : `<div class="${hostSurfaceClassName}">${html}</div>`;
}

/**
 * Loads `bodyHtml` under `theme` and measures every visible element whose own
 * text equals (string) or matches (RegExp) each matcher. Throws when a matcher
 * finds no visible text: a claimed state that no longer renders the text must
 * fail, never pass vacuously.
 */
export async function measureRenderedText(
  theme: Theme,
  bodyHtml: string,
  matchers: ReadonlyArray<string | RegExp>,
): Promise<RenderedTextMeasurement[][]> {
  const wire = matchers.map(toWire);
  const results = await withThemedPage(theme, bodyHtml, async (page) => {
    // Measure the settled state: no enter animation caught mid-fade.
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    });
    // Everything inside runs in Chrome. No named inner functions: tsx's
    // esbuild `keepNames` wraps them in a `__name()` helper the page lacks.
    return page.evaluate((wireMatchers) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const owned = [...document.body.querySelectorAll('*')]
        .filter((el) => el.tagName !== 'STYLE' && el.tagName !== 'SCRIPT')
        .map((el) => ({
          el,
          text: [...el.childNodes]
            .filter((c) => c.nodeType === 3)
            .map((c) => c.textContent ?? '')
            .join('')
            .replace(/\s+/g, ' ')
            .trim(),
        }))
        .filter((o) => o.text !== '');

      return wireMatchers.map((m) => owned.flatMap(({ el, text }) => {
        const hit = 'exact' in m ? text === m.exact : new RegExp(m.source, m.flags).test(text);
        if (!hit || !el.checkVisibility({ visibilityProperty: true })) return [];
        const layers: Element[] = [];
        for (let a: Element | null = el; a; a = a.parentElement) layers.unshift(a);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 1, 1);
        for (const layer of layers) {
          ctx.fillStyle = getComputedStyle(layer).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
        }
        const surface = Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
        let opacity = 1;
        for (let a: Element | null = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
        ctx.globalAlpha = opacity;
        ctx.fillStyle = getComputedStyle(el).color;
        ctx.fillRect(0, 0, 1, 1);
        const ink = Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
        return [{ text, surface, ink, className: el.getAttribute('class') ?? '' }];
      }));
    }, wire);
  });
  return results.map((hits, i) => {
    assert.ok(hits.length > 0, `no visible rendered text matched ${String(matchers[i])} in ${theme} theme`);
    return hits.map(({ text, surface, ink, className }) => ({
      text,
      className,
      ratio: contrastRatio(
        { r: ink[0], g: ink[1], b: ink[2], a: 1 },
        { r: surface[0], g: surface[1], b: surface[2], a: 1 },
      ),
    }));
  });
}

/** Every occurrence of every matcher clears `threshold`; failures name the painting class. */
export async function assertRenderedTextClears(
  theme: Theme,
  bodyHtml: string,
  matchers: ReadonlyArray<string | RegExp>,
  threshold: number,
): Promise<void> {
  const measured = await measureRenderedText(theme, bodyHtml, matchers);
  const failures = measured.flat().filter((m) => m.ratio < threshold);
  assert.deepEqual(
    failures.map((m) => `"${m.text}" ${m.ratio.toFixed(2)}:1 class="${m.className}"`),
    [],
    `rendered text below ${threshold}:1 in ${theme} theme`,
  );
}

/**
 * Negative control: rewrite the class of every element in the mounted
 * (happy-dom) DOM whose own text is `text` to a known-failing `className`,
 * then measure it exactly as the positive tests do and assert every hit falls
 * below `threshold`. Proves the measurement catches a failing class on the
 * real rendered element rather than passing regardless of input. Returns the
 * measured ratios so the caller can report them.
 */
export async function assertForcedClassReddens(
  theme: Theme,
  text: string,
  className: string,
  threshold: number,
  hostSurfaceClassName?: string,
): Promise<number[]> {
  const targets = [...document.body.querySelectorAll('*')].filter((el) => ownText(el) === text);
  assert.ok(targets.length > 0, `negative control: no rendered element paints "${text}"`);
  for (const el of targets) el.setAttribute('class', className);
  const [hits] = await measureRenderedText(theme, snapshotRenderedDom(hostSurfaceClassName), [text]);
  const ratios = hits.map((hit) => hit.ratio);
  assert.ok(
    ratios.every((ratio) => ratio < threshold),
    `negative control "${className}" on "${text}" measured ${ratios.map((r) => r.toFixed(2)).join(', ')}:1 in ${theme} theme, ` +
      `expected < ${threshold}:1: the harness stopped measuring, or the tokens changed enough that this class is no longer a valid regression fixture`,
  );
  return ratios;
}
