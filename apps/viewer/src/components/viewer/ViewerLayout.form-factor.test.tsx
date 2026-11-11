/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: the real layout follows the window's form factor. The command bar
 * sits under the viewport on a portrait phone and becomes a rail beside it on
 * a phone on its side; folding, rotating and attaching a mouse re-classify the
 * window live, and none of those resizes closes an open sheet (#5837).
 *
 * Only strings and booleans are asserted, never an element (a failing assert
 * on a happy-dom node inspects the whole tree).
 */

import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup } from '@/test/render.js';
import { renderMobileViewerLayout, renderViewerLayout } from '@/test/viewer-layout-harness.js';
import { useViewerStore } from '@/store';
import { DESKTOP_FORM_FACTOR, type SegmentRect } from '@/lib/layout/form-factor';

const ORIGINAL = { width: window.innerWidth, height: window.innerHeight, matchMedia: window.matchMedia };

/** A `(pointer: coarse)` query the test flips, firing `change` as a browser does. */
class CoarsePointerQuery extends EventTarget {
  readonly media = '(pointer: coarse)';
  constructor(public matches: boolean) { super(); }
  flip(matches: boolean): void {
    this.matches = matches;
    act(() => { this.dispatchEvent(new Event('change')); });
  }
}
let coarse = new CoarsePointerQuery(true);

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function resizeTo(width: number, height: number): void {
  setViewport(width, height);
  act(() => { window.dispatchEvent(new Event('resize')); });
}

/** `window.viewport.segments`, the Viewport Segments API; `null` removes it. */
function setSegments(segments: SegmentRect[] | null): void {
  Object.defineProperty(window, 'viewport', { configurable: true, value: segments ? { segments } : undefined });
}

const RESET = { isMobile: false, formFactor: DESKTOP_FORM_FACTOR, leftPanelCollapsed: true, rightPanelCollapsed: true };

/** Where the commands are, read off the rendered layout. */
function chrome(ui: HTMLElement) {
  const shell = ui.querySelector<HTMLElement>('[data-mobile-shell]');
  const bar = ui.querySelector<HTMLElement>('[data-command-surface="mobile"]');
  return {
    shell: shell?.dataset.mobileShell ?? null,
    bar: bar?.dataset.commandPlacement ?? null,
    // The bar follows the viewport area in the shell's flex flow: under it, or right of it.
    barAfterViewport: !!bar && !!shell && shell.lastElementChild === bar && shell.firstElementChild !== bar,
    row: shell?.classList.contains('flex-row') ?? false,
    ribbon: !!ui.querySelector('[data-tour="ribbon-tabs"]'),
  };
}

beforeEach(() => {
  coarse = new CoarsePointerQuery(true);
  window.matchMedia = (query: string) =>
    query === coarse.media ? coarse as unknown as MediaQueryList : ORIGINAL.matchMedia.call(window, query);
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setViewport(ORIGINAL.width, ORIGINAL.height);
  setSegments(null);
  window.matchMedia = ORIGINAL.matchMedia;
  useViewerStore.setState(RESET);
});

describe('ViewerLayout command placement per form factor (#9718)', () => {
  it('a portrait phone (Flip 412x960) has the bar under the viewport and no ribbon', async () => {
    setViewport(412, 960);
    const ui = await renderMobileViewerLayout();
    assert.equal(useViewerStore.getState().formFactor.mode, 'phone-portrait');
    assert.deepEqual(chrome(ui), { shell: 'bottom-bar', bar: 'bottom-bar', barAfterViewport: true, row: false, ribbon: false });
  });

  it('rotating to landscape moves the commands to a rail on the right, and back, without closing the open sheet', async () => {
    setViewport(412, 960);
    const ui = await renderMobileViewerLayout();
    act(() => useViewerStore.getState().setRightPanelCollapsed(false));
    resizeTo(960, 412);
    assert.equal(useViewerStore.getState().formFactor.mode, 'phone-landscape');
    assert.deepEqual(chrome(ui), { shell: 'side-rail', bar: 'side-rail', barAfterViewport: true, row: true, ribbon: false });
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false, 'rotation closed the sheet');
    resizeTo(412, 960);
    assert.equal(chrome(ui).bar, 'bottom-bar');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
  });

  it('folding into Flex Mode reports a tabletop fold, and unfolding restores the phone layout, the sheet still open', async () => {
    setViewport(412, 960);
    await renderMobileViewerLayout();
    act(() => useViewerStore.getState().setRightPanelCollapsed(false));
    setSegments([{ x: 0, y: 0, width: 412, height: 470 }, { x: 0, y: 490, width: 412, height: 470 }]);
    resizeTo(412, 960);
    const folded = useViewerStore.getState().formFactor;
    assert.equal(folded.mode, 'folded');
    assert.equal(folded.fold?.orientation, 'tabletop');
    assert.equal(useViewerStore.getState().isMobile, true);
    setSegments(null);
    resizeTo(412, 960);
    assert.equal(useViewerStore.getState().formFactor.mode, 'phone-portrait');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false, 'folding or unfolding closed the sheet');
  });

  it('a near-tablet touch screen re-classifies when a mouse takes over the pointer', async () => {
    setViewport(830, 750);
    const ui = await renderMobileViewerLayout();
    assert.equal(useViewerStore.getState().formFactor.mode, 'tablet-touch');
    assert.equal(chrome(ui).bar, 'bottom-bar');
    coarse.flip(false);
    assert.equal(useViewerStore.getState().formFactor.mode, 'desktop');
    assert.equal(useViewerStore.getState().isMobile, false);
    assert.equal(chrome(ui).ribbon, true);
  });

  it('a desktop window keeps the ribbon on top and no mobile shell', () => {
    coarse = new CoarsePointerQuery(false);
    setViewport(1600, 1000);
    const ui = renderViewerLayout();
    assert.deepEqual(chrome(ui), { shell: null, bar: null, barAfterViewport: false, row: false, ribbon: true });
  });
});
