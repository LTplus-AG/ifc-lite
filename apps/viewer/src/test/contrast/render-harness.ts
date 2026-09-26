/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders the app's REAL Tailwind utility classes, on the app's REAL theme
 * tokens (`apps/viewer/src/index.css`), in a REAL headless browser, and
 * returns a measured WCAG contrast ratio — the only way to actually observe
 * a contrast relationship rather than a className string.
 *
 * Why this exists: `TooltipContent` (`apps/viewer/src/components/ui/tooltip.tsx`)
 * switched its surface from `bg-primary` to `bg-popover` in #4767, which
 * silently broke three sibling components (#4783/#4784) that hardcoded
 * `text-primary-foreground` on the old premise. Both #4767's test and
 * #4784's assert rendered classNames in `happy-dom`, which loads no
 * stylesheet — they can prove a string did not change, never that anything
 * is visible. This harness renders the classes for real so a test can
 * assert the thing that actually matters.
 *
 * Deliberately does NOT build or serve the app (no `vite build`, no preview
 * server, no React mount) — that would need a full viewer build, which is
 * both slow and, on a disk-constrained box, the wrong tool for a question
 * that is really "what color do these two tokens resolve to and composite
 * into". Tailwind v4 (`@tailwindcss/postcss`) compiles `index.css` directly
 * with the exact plugin chain `apps/viewer/postcss.config.js` uses; its
 * automatic content scan finds the utility classes already used by the real
 * component source under `apps/viewer/src`, so the generated CSS is the
 * same CSS the real app ships.
 *
 * Tailwind v4's palette is defined in OKLCH/OKLAB, which `getComputedStyle`
 * serializes verbatim (e.g. `oklab(0.552 0.004 -0.013 / 0.8)` for a
 * `/80`-opacity utility) rather than converting to `rgb()`. A hand-rolled
 * parser for that is a second color engine to keep in sync with the
 * browser's; instead every color is resolved by asking a real `<canvas>` 2D
 * context to composite it (`fillStyle` + `fillRect`, "source-over", the same
 * operator the browser paints with) and reading the pixel back — correct
 * for any CSS color syntax Chromium accepts, including a translucent color
 * painted over an opaque surface.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';
import { chromium, type Browser, type Page } from '@playwright/test';
import { contrastRatio, type Rgba } from './wcag';
import { extractFirstStringLiteralAfter } from './extract-classname';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_ROOT = join(__dirname, '../../../');
const INDEX_CSS_PATH = join(VIEWER_ROOT, 'src/index.css');
const TOOLTIP_TSX_PATH = join(VIEWER_ROOT, 'src/components/ui/tooltip.tsx');

/** The real `TooltipContent` surface class, pulled from
 *  `apps/viewer/src/components/ui/tooltip.tsx`'s SOURCE (`extract-classname.ts`)
 *  rather than typed here — so if `TooltipContent`'s `cn('...', className)`
 *  base string ever changes again (the way #4767 changed it from
 *  `bg-primary` to `bg-popover`), every contrast test in this directory
 *  renders the surface production actually ships today, not a string this
 *  file guessed at and could fall out of sync with. The anchor
 *  `<TooltipPrimitive.Content` identifies that component's own JSX opening
 *  tag, so `extractFirstStringLiteralAfter` reads the first quoted literal
 *  inside it — the `cn(...)` call's base-class argument — and nothing past
 *  that tag's closing `>`. */
export const TOOLTIP_CONTENT_SURFACE_CLASS = extractFirstStringLiteralAfter(
  TOOLTIP_TSX_PATH,
  '<TooltipPrimitive.Content',
);

let compiledCssPromise: Promise<string> | undefined;

/** Compiles the app's real `index.css` (Tailwind v4 + the theme's custom
 *  properties) with the exact plugin chain `postcss.config.js` uses. Cached
 *  process-wide — every test in this file shares one compile (~1s). */
export function compileAppCss(): Promise<string> {
  if (!compiledCssPromise) {
    compiledCssPromise = (async () => {
      const css = readFileSync(INDEX_CSS_PATH, 'utf-8');
      const result = await postcss([tailwindcss(), autoprefixer()]).process(css, {
        from: INDEX_CSS_PATH,
        to: undefined,
      });
      return result.css;
    })();
  }
  return compiledCssPromise;
}

let browserPromise: Promise<Browser> | undefined;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // `channel: 'chrome'` launches the real, preinstalled Google Chrome
    // instead of Playwright's own bundled `chromium_headless_shell` — the
    // same reason every Playwright project in `playwright.config.ts` pins
    // this channel (see e.g. `viewer-e2e-ci`'s comment). This suite runs
    // inside `apps/viewer`'s `pnpm test` (tsx --test, sharded across CI's
    // "Viewer tests" lane, not `playwright test`), and that lane's workflow
    // step has no `playwright install`, so the bundled browser is never
    // downloaded there — only `channel: 'chrome'` resolves without one, on
    // both GitHub-hosted runners (Chrome preinstalled) and the self-hosted
    // "ifclite" runner (already relied on by the E2E lane's identical
    // `runs-on` expression). A developer machine needs real Chrome too, same
    // as running `pnpm test:e2e`.
    browserPromise = chromium.launch({ headless: true, channel: 'chrome' });
  }
  return browserPromise;
}

/** Closes the shared browser. Call once from an `after()` hook. */
export async function closeContrastBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = undefined;
  }
}

export type Theme = 'light' | 'dark' | 'colorful';

/** Resolve an interactive text color before and after hover, alongside the
 * plain utility color the hover variant is expected to reveal. */
export async function measureTextHoverColors(
  theme: Theme,
  textClassName: string,
  expectedHoverClassName: string,
): Promise<{ before: string; after: string; expected: string }> {
  const css = await compileAppCss();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html>
<html class="${themeHtmlClass(theme)}">
<head><meta charset="utf-8"><style>${css}</style></head>
<body><button id="target" class="${textClassName}">Target</button><span id="expected" class="${expectedHoverClassName}">Expected</span></body>
</html>`, { waitUntil: 'load' });
    const before = await page.$eval('#target', (el) => getComputedStyle(el).color);
    const expected = await page.$eval('#expected', (el) => getComputedStyle(el).color);
    await page.hover('#target');
    const after = await page.$eval('#target', (el) => getComputedStyle(el).color);
    return { before, after, expected };
  } finally {
    await page.close();
  }
}

/** The class the real app puts on `<html>` for each theme, mirroring
 *  `apps/viewer/src/store/slices/uiSlice.ts`'s `applyTheme`
 *  (`el.classList.toggle('dark', theme === 'dark')`,
 *  `el.classList.toggle('colorful', theme === 'colorful')`) — the three
 *  states are mutually exclusive; light is the unmarked default. */
function themeHtmlClass(theme: Theme): string {
  switch (theme) {
    case 'light':
      return '';
    case 'dark':
      return 'dark';
    case 'colorful':
      return 'colorful';
  }
}

/** Resolves a CSS color string to an opaque {r,g,b} by compositing it (via a
 *  real 2D canvas, "source-over") over `backdrop`. If `color` is itself
 *  opaque this just re-serializes it; if translucent, this is the actual
 *  paint-time blend, valid for any CSS color syntax the browser accepts
 *  (rgb, oklch, oklab, color-mix, ...). */
async function resolveOverBackdrop(page: Page, color: string, backdrop: string): Promise<Rgba> {
  const { r, g, b } = await page.evaluate(
    ({ color, backdrop }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = backdrop;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    },
    { color, backdrop },
  );
  return { r, g, b, a: 1 };
}

/**
 * Renders `surfaceClassName` with one child `<span>` carrying
 * `textClassName`, under the given theme, with the compiled app CSS loaded,
 * and returns the measured WCAG contrast ratio of the text against that
 * surface — a real paint, not a className comparison. Generalizes
 * {@link measureTooltipTextContrast} (which hardcodes the tooltip's popover
 * surface) to any `(surfaceClass, textClass, theme)` triple, since a WCAG
 * ratio for a given class pair is a pure function of those three inputs —
 * it doesn't depend on which component uses it (see #4792's survey, which
 * measured every distinct combination in source this way before this helper
 * existed as a script).
 *
 * When `backdropClassName` is given, `surfaceClassName` is treated as a
 * (possibly translucent) layer painted OVER that backdrop — e.g.
 * `PanelWindowHost`'s `bg-muted/40` header stacked over its ancestor's
 * `bg-background` — rather than as an opaque surface in its own right. The
 * surface is rendered nested inside the backdrop element (mirroring the
 * real DOM ancestry) and composited onto it with the same
 * {@link resolveOverBackdrop} canvas-compositor already used to resolve a
 * translucent TEXT color onto its surface below — reused here rather than
 * duplicated, since "translucent layer over an opaque backdrop" is one
 * operation regardless of which layer (text or surface) is translucent.
 * The text color is then resolved onto that composited (now-opaque)
 * surface color, same as the no-backdrop path. Omitting `backdropClassName`
 * keeps the original behavior exactly (surface resolved "over itself",
 * i.e. treated as already opaque), so every existing call site is
 * unaffected.
 */
export async function measureTextContrastOnSurface(
  theme: Theme,
  surfaceClassName: string,
  textClassName: string,
  backdropClassName?: string,
): Promise<number> {
  return measureRenderedTextContrastOnSurface(
    theme,
    surfaceClassName,
    `<span id="txt" class="${textClassName}">Sample text</span>`,
    '#txt',
    backdropClassName,
  );
}

/** Measure a selector in rendered component markup against its panel surface. */
export async function measureRenderedTextContrastOnSurface(
  theme: Theme,
  surfaceClassName: string,
  markup: string,
  textSelector: string,
  backdropClassName?: string,
): Promise<number> {
  const css = await compileAppCss();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const surfaceMarkup = `<div id="surface" class="${surfaceClassName}">${markup}</div>`;
    const body =
      backdropClassName === undefined
        ? surfaceMarkup
        : `<div id="backdrop" class="${backdropClassName}">${surfaceMarkup}</div>`;
    const html = `<!doctype html>
<html class="${themeHtmlClass(theme)}">
<head><meta charset="utf-8"><style>${css}</style></head>
<body>
  ${body}
</body>
</html>`;
    await page.setContent(html, { waitUntil: 'load' });
    const surfaceColorRaw = await page.$eval('#surface', (el) => getComputedStyle(el).backgroundColor);
    const textColorRaw = await page.$eval(textSelector, (el) => getComputedStyle(el).color);
    let surface: Rgba;
    if (backdropClassName === undefined) {
      surface = await resolveOverBackdrop(page, surfaceColorRaw, surfaceColorRaw);
    } else {
      const backdropColorRaw = await page.$eval('#backdrop', (el) => getComputedStyle(el).backgroundColor);
      surface = await resolveOverBackdrop(page, surfaceColorRaw, backdropColorRaw);
    }
    const surfaceCss = `rgb(${surface.r}, ${surface.g}, ${surface.b})`;
    const text = await resolveOverBackdrop(page, textColorRaw, surfaceCss);
    return contrastRatio(text, surface);
  } finally {
    await page.close();
  }
}

/**
 * Renders `TOOLTIP_CONTENT_SURFACE_CLASS` with one child `<span>` carrying
 * `textClassName`, under the given theme, with the compiled app CSS loaded,
 * and returns the measured WCAG contrast ratio of the text against the
 * tooltip surface — a real paint, not a className comparison.
 */
export function measureTooltipTextContrast(theme: Theme, textClassName: string): Promise<number> {
  return measureTextContrastOnSurface(theme, TOOLTIP_CONTENT_SURFACE_CLASS, textClassName);
}
