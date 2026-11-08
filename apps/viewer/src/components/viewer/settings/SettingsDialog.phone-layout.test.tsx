/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings on a phone (#8802, found by the maintainer on a real phone).
 *
 * 1. The dialog scrolls. `DialogContent` capped its height with
 *    `overflow-hidden`, but it is a grid whose row was not height-limited, so
 *    the inner `overflow-y-auto` area grew and was clipped instead of
 *    scrolling: the lower General settings could not be reached at all.
 * 2. The sections read as tabs. They were a two-column grid of plain words
 *    with a faint `bg-muted` selection; they are now one horizontally
 *    scrolling strip of 44 px tabs with the R4 active state.
 *
 * The dialog is mounted for real (happy-dom) in German, whose labels are the
 * longest, then its markup is laid out in real Chrome with the compiled app
 * stylesheet at phone sizes. Only numbers and booleans leave the page, never
 * an element.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { cleanup, render, waitFor } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage, type Theme } from '@/test/contrast/render-harness.js';
import { SettingsDialog } from './SettingsDialog.js';
import type { SettingsSection } from '@/lib/settings/open-settings';

const PHONES = [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
] as const;
/** Short desktop windows: the body must shrink with the capped dialog
 *  instead of holding a floor that pushes its end past the dialog's bottom. */
const SHORT_DESKTOPS = [
  { width: 1024, height: 240 },
  { width: 1280, height: 400 },
] as const;
/** Desktop's steady floor before the fix: 20rem body + 67 px header + 2 px border. */
const DESKTOP_FLOOR_PX = 389;
const THEMES: Theme[] = ['light', 'dark', 'colorful'];
/** The smallest touch target a phone tab may have (WCAG 2.5.5 / platform HIGs). */
const MIN_TAB_PX = 44;
/** Euclidean RGB distance the selected tab's paint must differ by. */
const MIN_COLOUR_DISTANCE = 20;

const initial = useViewerStore.getState();
const de = (await import('@/i18n/locales/de')).default;

before(warmContrastBrowser);
afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(initial);
});
after(closeContrastBrowser);

/** General's last two groups (IFC federation, LandXML georeferencing) load
 *  lazily; each adds a switch after the hover-tooltips one. */
const GENERAL_SWITCHES = 3;

/** Markup of the open dialog, as Radix portals it into the body. */
async function dialogHtml(section: SettingsSection): Promise<string> {
  registerLocale('de', de);
  setLocale('de');
  render(<SettingsDialog open section={section} onSectionChange={() => {}} onOpenChange={() => {}} />);
  if (section === 'general') {
    await waitFor(() => document.querySelectorAll('[data-settings-dialog] [role="switch"]').length >= GENERAL_SWITCHES,
      'General\'s lazy federation and LandXML groups', 10_000);
  }
  const html = document.querySelector('[data-settings-dialog]')?.outerHTML ?? '';
  cleanup();
  assert.ok(html.length > 0, 'the Settings dialog renders');
  return html;
}

async function settle(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate('globalThis.__name = (fn) => fn;');
  // The open animation scales the dialog; measure its resting layout.
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
}

interface ScrollProbe {
  dialogFits: boolean;
  dialogTop: number;
  dialogBottom: number;
  bodyInside: boolean;
  bodyBottom: number;
  scrollers: number;
  controls: number;
  lastControlVisible: boolean;
  lastControlBottom: number;
  visibleBottom: number;
}

/** Scrolls every vertical scroller in the dialog to its end, then reports
 *  whether the active section's last control lies wholly inside the part of
 *  the viewport that no clipping ancestor hides. */
function probeScroll(page: Page): Promise<ScrollProbe> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-settings-dialog]') as HTMLElement;
    const all = [dialog, ...dialog.querySelectorAll<HTMLElement>('*')];
    const scrollers = all.filter((el) => {
      const { overflowY } = getComputedStyle(el);
      return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    });
    const frame = dialog.getBoundingClientRect();
    for (const el of scrollers) el.scrollTop = el.scrollHeight;
    // The scroller's own box must end inside the dialog: past its clipped
    // bottom, the end of the content can never be scrolled into view.
    const body = scrollers.length ? scrollers[scrollers.length - 1].getBoundingClientRect() : frame;
    const panel = dialog.querySelector('[role="tabpanel"][data-state="active"]') as HTMLElement;
    const controls = [...panel.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="switch"]')];
    const last = controls[controls.length - 1];
    const box = last.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    let left = 0;
    let right = window.innerWidth;
    for (let el = last.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = el.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    return {
      dialogFits: frame.top >= -0.5 && frame.bottom <= window.innerHeight + 0.5,
      dialogTop: Math.round(frame.top),
      dialogBottom: Math.round(frame.bottom),
      bodyInside: body.top >= frame.top - 0.5 && body.bottom <= frame.bottom + 0.5,
      bodyBottom: Math.round(body.bottom),
      scrollers: scrollers.length,
      controls: controls.length,
      lastControlVisible: box.top >= top - 0.5 && box.bottom <= bottom + 0.5 && box.left >= left - 0.5 && box.right <= right + 0.5,
      lastControlBottom: Math.round(box.bottom),
      visibleBottom: Math.round(bottom),
    };
  });
}

interface TabProbe {
  tabs: number;
  rows: number;
  minHeight: number;
  orientation: string | null;
  activeCount: number;
  bgDistance: number;
  inkDistance: number;
}

/** Measures the section tabs: rows, heights, and how far the selected tab's
 *  background (composited over the dialog) and ink sit from the nearest
 *  unselected tab's. */
function probeTabs(page: Page): Promise<TabProbe> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-settings-dialog]') as HTMLElement;
    const tabs = [...dialog.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const paint = (layers: string[]): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1, 1);
      for (const colour of layers) {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
      }
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const surface = getComputedStyle(dialog).backgroundColor;
    const bg = (el: HTMLElement) => paint([surface, getComputedStyle(el).backgroundColor]);
    const ink = (el: HTMLElement) => paint([surface, getComputedStyle(el).color]);
    const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const active = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    const others = tabs.filter((tab) => tab.getAttribute('aria-selected') !== 'true');
    const selected = active[0];
    return {
      tabs: tabs.length,
      rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
      minHeight: Math.min(...tabs.map((tab) => tab.getBoundingClientRect().height)),
      orientation: dialog.querySelector('[role="tablist"]')?.getAttribute('aria-orientation') ?? null,
      activeCount: active.length,
      bgDistance: selected ? Math.min(...others.map((tab) => distance(bg(selected), bg(tab)))) : 0,
      inkDistance: selected ? Math.min(...others.map((tab) => distance(ink(selected), ink(tab)))) : 0,
    };
  });
}

describe('Settings on a phone (#8802)', () => {
  it('scrolls its body so the last General control can be reached', async () => {
    const html = await dialogHtml('general');
    for (const { width, height } of PHONES) {
      const probe = await withThemedPage('light', html, async (page) => {
        await settle(page, width, height);
        return probeScroll(page);
      });
      assert.ok(probe.controls >= GENERAL_SWITCHES + 2, `General renders its controls at ${width}x${height} (${probe.controls})`);
      assert.equal(probe.dialogFits, true, `the dialog (top ${probe.dialogTop}px, bottom ${probe.dialogBottom}px) fits the ${width}x${height} viewport`);
      assert.equal(probe.bodyInside, true, `the scrolling body (bottom ${probe.bodyBottom}px) ends inside the dialog (bottom ${probe.dialogBottom}px) at ${width}x${height}`);
      assert.equal(probe.lastControlVisible, true,
        `after scrolling, the last General control (bottom ${probe.lastControlBottom}px) is inside the visible area (bottom ${probe.visibleBottom}px) at ${width}x${height}`);
      assert.equal(probe.scrollers, 1, `exactly one element scrolls at ${width}x${height}, not ${probe.scrollers}`);
    }
  });

  it('keeps the body inside the dialog at short desktop heights (#8802 review)', async () => {
    const html = await dialogHtml('general');
    for (const { width, height } of SHORT_DESKTOPS) {
      const probe = await withThemedPage('light', html, async (page) => {
        await settle(page, width, height);
        return probeScroll(page);
      });
      assert.equal(probe.dialogFits, true, `the dialog (top ${probe.dialogTop}px, bottom ${probe.dialogBottom}px) fits the ${width}x${height} viewport`);
      assert.equal(probe.bodyInside, true, `the scrolling body (bottom ${probe.bodyBottom}px) ends inside the dialog (bottom ${probe.dialogBottom}px) at ${width}x${height}`);
      assert.equal(probe.lastControlVisible, true,
        `after scrolling, the last General control (bottom ${probe.lastControlBottom}px) is inside the visible area (bottom ${probe.visibleBottom}px) at ${width}x${height}`);
      assert.equal(probe.scrollers, 1, `exactly one element scrolls at ${width}x${height}, not ${probe.scrollers}`);
    }
    // A tall window keeps desktop's steady floor for a short section.
    const short = await dialogHtml('collaboration');
    const height = await withThemedPage('light', short, async (page) => {
      await settle(page, 1280, 800);
      return page.evaluate(() => Math.round((document.querySelector('[data-settings-dialog]') as HTMLElement).getBoundingClientRect().height));
    });
    assert.ok(height >= DESKTOP_FLOOR_PX, `a short section keeps the ${DESKTOP_FLOOR_PX}px desktop floor at 1280x800 (${height}px)`);
  });

  it('shows its sections as one row of 44 px tabs with an obvious selection', async () => {
    for (const section of ['general', 'collaboration'] as const) {
      const html = await dialogHtml(section);
      for (const theme of THEMES) {
        for (const { width, height } of PHONES) {
          const probe = await withThemedPage(theme, html, async (page) => {
            await settle(page, width, height);
            return probeTabs(page);
          });
          const where = `${section} in ${theme} at ${width}x${height}`;
          assert.equal(probe.tabs, 5, `${where}: five section tabs`);
          assert.equal(probe.activeCount, 1, `${where}: one selected tab`);
          assert.equal(probe.rows, 1, `${where}: the tabs sit in one row, not ${probe.rows}`);
          assert.ok(probe.minHeight >= MIN_TAB_PX, `${where}: every tab is at least ${MIN_TAB_PX}px tall (smallest ${probe.minHeight}px)`);
          assert.ok(probe.bgDistance >= MIN_COLOUR_DISTANCE,
            `${where}: the selected tab's background differs from the others by ${probe.bgDistance.toFixed(1)}, expected >= ${MIN_COLOUR_DISTANCE}`);
          assert.ok(probe.inkDistance >= MIN_COLOUR_DISTANCE,
            `${where}: the selected tab's label colour differs from the others by ${probe.inkDistance.toFixed(1)}, expected >= ${MIN_COLOUR_DISTANCE}`);
        }
      }
    }
  });
});
