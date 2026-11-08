/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Info dialog keeps its content on the panel (#8802, reported with a
 * screenshot at 1033x676): the tab strip, the Learn rows and the header's
 * "Drive from any LLM" pill and close button ran far past the panel's right
 * edge. `DialogContent` was a grid, and its one track grew to the widest
 * unbreakable row (the nowrap Learn descriptions, four `flex-1` tabs, the
 * nowrap pill) while the panel stayed `max-w-md`.
 *
 * Each tab is mounted for real (happy-dom) in English and in every shipped
 * locale (found the way `locales.boot.ts` finds them, so a new language is
 * covered the day it lands), then its markup is laid out in real Chrome with the compiled app
 * stylesheet at desktop and phone sizes in light and dark. Only numbers,
 * booleans and short descriptions leave the page, never an element.
 */

import '@/test/setup-dom.js';
// Vite `define` build-time constants (see vite.config.ts); stand-ins under Node.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
(globalThis as unknown as { __BUILD_DATE__: string }).__BUILD_DATE__ = '2026-01-01T00:00:00.000Z';
(globalThis as unknown as { __PACKAGE_VERSIONS__: Array<{ name: string; version: string }> }).__PACKAGE_VERSIONS__ = [
  { name: '@ifc-lite/viewer', version: '0.0.0-test' },
];
(globalThis as unknown as { __RELEASE_HISTORY__: unknown[] }).__RELEASE_HISTORY__ = [
  {
    name: '@ifc-lite/viewer',
    releases: [{
      version: '0.0.0-test',
      highlights: [{ type: 'feature', text: 'Release highlight: the Info dialog keeps every tab on its panel at desktop and phone widths' }],
    }],
  },
];

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';
import { registerLocale, setLocale } from '@/i18n';
import { cleanup, render, waitFor } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage, type Theme } from '@/test/contrast/render-harness.js';
import { KeyboardShortcutsDialog, type InfoDialogTab } from './KeyboardShortcutsDialog.js';

/** The reported window first, then a laptop and two phones. */
const VIEWPORTS = [
  { width: 1033, height: 676 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
] as const;
const TABS: InfoDialogTab[] = ['about', 'whatsnew', 'shortcuts', 'learn'];
/** Every shipped locale: `locales.boot.ts` globs `locales/*.ts` (not tests). */
const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../i18n/locales');
const SHIPPED = readdirSync(LOCALE_DIR).filter((file) => /^[^.]+\.ts$/.test(file)).map((file) => file.slice(0, -'.ts'.length)).sort();
const CATALOGUES = new Map<string, Parameters<typeof registerLocale>[1]>();
for (const tag of SHIPPED) {
  CATALOGUES.set(tag, (await import(pathToFileURL(join(LOCALE_DIR, `${tag}.ts`)).href)).default);
}
const LOCALES = ['en', ...SHIPPED];
const THEMES: Theme[] = ['light', 'dark'];
/** Tabs whose content outgrows the body on a small phone, so the body must
 *  scroll (the in-CI review of 35c524503: zero scrollers also passed `<= 1`). */
const MUST_SCROLL = new Set(['shortcuts@320x640', 'learn@320x640']);
/** Below this the dialog would be cramped on a desktop; `max-w-md` was 448. */
const MIN_DESKTOP_WIDTH_PX = 440;

// Dynamic: the revert oracle deletes this module, and a static import would
// fail the whole file instead of letting the assertions go red.
const strip = await import('@/components/ui/use-scroll-strip').catch(() => null);

before(warmContrastBrowser);
afterEach(() => {
  cleanup();
  setLocale('en');
});
after(closeContrastBrowser);

/** Markup of the open dialog on `tab`, as Radix portals it into the body. */
async function dialogHtml(tab: InfoDialogTab, locale: string): Promise<string> {
  const catalogue = CATALOGUES.get(locale);
  if (catalogue) registerLocale(locale, catalogue);
  setLocale(locale);
  render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab={tab} />);
  if (tab === 'whatsnew') {
    await waitFor(() => (document.body.textContent ?? '').includes('Release highlight'), "the lazy What's New tab", 10_000);
  }
  const html = document.querySelector('[role="dialog"]')?.outerHTML ?? '';
  cleanup();
  assert.ok(html.length > 0, 'the Info dialog renders');
  return html;
}

async function settle(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate('globalThis.__name = (fn) => fn;');
  // The open animation scales the dialog; measure its resting layout.
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
}

interface LayoutProbe {
  panelWidth: number;
  panelFits: boolean;
  /** Elements whose box leaves the panel sideways, e.g. `button "Learn" 802..993`. */
  escapes: string[];
  headerInside: boolean;
  footerInside: boolean;
  scrollers: number;
  /** The one scroller is the active tab panel, i.e. the `DialogBody`. */
  bodyIsScroller: boolean;
  /** The tab's content is taller than its body (`scrollHeight` over `clientHeight`). */
  contentTaller: boolean;
  /** After every user scroller is scrolled to its end, the active panel's last
   *  visible element lies inside what its clipping ancestors leave visible. */
  lastReachable: boolean;
  lastBottom: number;
  visibleBottom: number;
  stripScrolls: boolean;
  selectedTabVisible: boolean;
}

/**
 * Every element must stay between the panel's left and right edges, unless
 * an ancestor clips it on purpose (a truncated label) or it is a tab in a
 * strip that scrolls sideways; those boxes are judged themselves. A box that
 * merely scrolls vertically does not excuse its content: content wider than
 * the scroll body would scroll sideways.
 */
async function probeLayout(page: Page, reveal: string | null): Promise<LayoutProbe> {
  // The strip's own logic, run in the page: keep the selected tab in view.
  if (reveal) await page.evaluate(`(${reveal})(document.querySelector('[role="dialog"] [role="tablist"]'))`);
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const tablist = dialog.querySelector('[role="tablist"]') as HTMLElement;
    const frame = dialog.getBoundingClientRect();
    const excused = (el: Element): boolean => {
      for (let a = el.parentElement; a && a !== dialog; a = a.parentElement) {
        const { overflowX } = getComputedStyle(a);
        if (overflowX === 'hidden' || overflowX === 'clip') return true;
        if (a === tablist && (overflowX === 'auto' || overflowX === 'scroll')) return true;
      }
      return false;
    };
    const escapes: string[] = [];
    for (const el of dialog.querySelectorAll<HTMLElement>('*')) {
      if (excused(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.left < frame.left - 0.5 || box.right > frame.right + 0.5) {
        const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 32);
        escapes.push(`${el.tagName.toLowerCase()} "${text}" ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
    }
    const inside = (el: Element | null) => {
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return box.top >= frame.top - 0.5 && box.bottom <= frame.bottom + 0.5 && box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5;
    };
    const scrollers = [dialog, ...dialog.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const { overflowY } = getComputedStyle(el);
      return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    });
    const selected = tablist.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
    const stripBox = tablist.getBoundingClientRect();
    const tabBox = selected.getBoundingClientRect();
    // Reachability, measured last because it scrolls.
    const panel = dialog.querySelector('[role="tabpanel"][data-state="active"]') as HTMLElement;
    const contentTaller = panel.scrollHeight > panel.clientHeight + 1;
    for (const el of scrollers) el.scrollTop = el.scrollHeight;
    const sized = [...panel.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const last = sized[sized.length - 1] ?? panel;
    const lastBox = last.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    for (let el = last.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = el.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    return {
      panelWidth: Math.round(frame.width),
      panelFits: frame.left >= -0.5 && frame.right <= window.innerWidth + 0.5 && frame.top >= -0.5 && frame.bottom <= window.innerHeight + 0.5,
      escapes,
      headerInside: inside(dialog.firstElementChild),
      footerInside: inside(dialog.lastElementChild),
      scrollers: scrollers.length,
      bodyIsScroller: scrollers.length === 1 && scrollers[0] === panel,
      contentTaller,
      lastReachable: lastBox.top >= top - 0.5 && lastBox.bottom <= bottom + 0.5,
      lastBottom: Math.round(lastBox.bottom),
      visibleBottom: Math.round(bottom),
      stripScrolls: ['auto', 'scroll'].includes(getComputedStyle(tablist).overflowX),
      selectedTabVisible: tabBox.left >= stripBox.left - 0.5 && tabBox.right <= stripBox.right + 0.5,
    };
  });
}

describe('Info dialog layout (#8802)', () => {
  it('finds the shipped locales the way the app does', () => {
    for (const tag of ['de', 'fr', 'ru']) assert.equal(SHIPPED.includes(tag), true, `locales/${tag}.ts is covered`);
  });

  for (const tab of TABS) {
    it(`keeps the ${tab} tab on the panel at desktop and phone sizes`, async () => {
      for (const locale of LOCALES) {
        const html = await dialogHtml(tab, locale);
        for (const theme of THEMES) {
          await withThemedPage(theme, html, async (page) => {
            for (const { width, height } of VIEWPORTS) {
              await settle(page, width, height);
              const probe = await probeLayout(page, strip ? strip.revealSelected.toString() : null);
              const where = `${tab} (${locale}, ${theme}) at ${width}x${height}`;
              assert.equal(probe.escapes.length, 0, `${where}: content leaves the ${probe.panelWidth}px panel: ${probe.escapes.slice(0, 4).join('; ')}`);
              assert.equal(probe.panelFits, true, `${where}: the panel fits the viewport`);
              assert.equal(probe.headerInside, true, `${where}: the header, with its close button, is inside the panel`);
              assert.equal(probe.footerInside, true, `${where}: the footer is inside the panel`);
              assert.ok(probe.scrollers <= 1, `${where}: at most one element scrolls, not ${probe.scrollers}`);
              assert.equal(probe.lastReachable, true,
                `${where}: scrolled to the end, the tab's last element (bottom ${probe.lastBottom}px) is visible (visible bottom ${probe.visibleBottom}px)`);
              if (MUST_SCROLL.has(`${tab}@${width}x${height}`)) {
                // Zero scrollers must not pass: the dialog's overflow-hidden would clip the rest.
                assert.equal(probe.contentTaller, true, `${where}: the tab's content is taller than its body`);
                assert.equal(probe.scrollers, 1, `${where}: exactly one element scrolls, not ${probe.scrollers}`);
                assert.equal(probe.bodyIsScroller, true, `${where}: the scroller is the dialog body`);
              }
              assert.equal(probe.stripScrolls, true, `${where}: the tab strip scrolls sideways when it is too narrow`);
              assert.equal(probe.selectedTabVisible, true, `${where}: the selected tab is in view in the strip`);
              if (width >= 1024) {
                assert.ok(probe.panelWidth >= MIN_DESKTOP_WIDTH_PX, `${where}: the panel keeps a desktop width (${probe.panelWidth}px)`);
              }
            }
          });
        }
      }
    });
  }
});
