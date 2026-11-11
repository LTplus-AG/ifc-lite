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
import { renderViewerLayout } from '@/test/viewer-layout-harness.js';
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
    // The bar follows the viewport area on the shell's grid: under it, or right of it.
    barAfterViewport: !!bar && !!shell && shell.lastElementChild === bar && shell.firstElementChild !== bar,
    areas: shell?.style.gridTemplateAreas ?? null,
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
  it('a portrait phone (Flip 412x960) has the bar under the viewport and no ribbon', () => {
    setViewport(412, 960);
    const ui = renderViewerLayout();
    assert.equal(useViewerStore.getState().formFactor.mode, 'phone-portrait');
    assert.deepEqual(chrome(ui), { shell: 'bottom-bar', bar: 'bottom-bar', barAfterViewport: true, areas: '"view" "bar"', ribbon: false });
  });

  it('rotating to landscape moves the commands to a rail on the right, and back, without closing the open sheet', () => {
    setViewport(412, 960);
    const ui = renderViewerLayout();
    act(() => useViewerStore.getState().setRightPanelCollapsed(false));
    resizeTo(960, 412);
    assert.equal(useViewerStore.getState().formFactor.mode, 'phone-landscape');
    assert.deepEqual(chrome(ui), { shell: 'side-rail', bar: 'side-rail', barAfterViewport: true, areas: '"view pane bar"', ribbon: false });
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false, 'rotation closed the sheet');
    resizeTo(412, 960);
    assert.equal(chrome(ui).bar, 'bottom-bar');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
  });

  it('folding into Flex Mode reports a tabletop fold, and unfolding restores the phone layout, the sheet still open', () => {
    setViewport(412, 960);
    renderViewerLayout();
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

  it('a near-tablet touch screen re-classifies when a mouse takes over the pointer', () => {
    setViewport(830, 750);
    const ui = renderViewerLayout();
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
    assert.deepEqual(chrome(ui), { shell: null, bar: null, barAfterViewport: false, areas: null, ribbon: true });
  });
});

/** Where the open panel is, read off the rendered layout (strings and booleans only). */
function panels(ui: HTMLElement) {
  const shell = ui.querySelector<HTMLElement>('[data-mobile-shell]');
  const slot = ui.querySelector<HTMLElement>('[data-mobile-pane-slot]');
  const pane = slot?.querySelector<HTMLElement>('[data-mobile-pane]') ?? null;
  const area = (el: Element) => el.hasAttribute('data-mobile-viewport') ? 'view'
    : el.hasAttribute('data-mobile-pane-slot') ? 'pane'
      : el.hasAttribute('data-command-surface') ? 'bar' : el.tagName;
  return {
    host: shell?.dataset.mobilePanelHost ?? null,
    sheet: ui.querySelector('[data-mobile-sheet]') !== null,
    pane: pane?.dataset.mobilePane ?? null,
    paneTitle: pane?.querySelector('.font-semibold')?.textContent ?? null,
    scrim: [...ui.ownerDocument.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Close panels'),
    order: shell ? [...shell.children].map(area).join(' ') : null,
  };
}

const TABLETOP: SegmentRect[] = [{ x: 0, y: 0, width: 412, height: 470 }, { x: 0, y: 490, width: 412, height: 470 }];
const BOOK: SegmentRect[] = [{ x: 0, y: 0, width: 405, height: 750 }, { x: 425, y: 0, width: 405, height: 750 }];

describe('ViewerLayout panel placement per form factor (#9718 DoD 3-5)', () => {
  it('a portrait phone keeps the modal bottom sheet with its scrim', () => {
    setViewport(412, 960);
    const ui = renderViewerLayout();
    act(() => useViewerStore.getState().setRightPanelCollapsed(false));
    assert.deepEqual(panels(ui), { host: 'sheet', sheet: true, pane: null, paneTitle: null, scrim: true, order: 'view pane bar' });
  });

  it('a phone on its side docks the panel between the model and the rail, non-modal', () => {
    setViewport(960, 412);
    const ui = renderViewerLayout();
    act(() => useViewerStore.getState().setLeftPanelCollapsed(false));
    assert.deepEqual(panels(ui), { host: 'side-pane', sheet: false, pane: 'side-pane', paneTitle: 'Hierarchy', scrim: false, order: 'view pane bar' });
    // The pane's width and insets (clamp(), env()) are `mobile-shell-layout.test.ts`'s: happy-dom drops both from inline styles.
  });

  it('a near-tablet (Z Fold inner 830x750) docks the pane right of the viewport, the bar under both', () => {
    setViewport(830, 750);
    const ui = renderViewerLayout();
    act(() => useViewerStore.getState().setRightPanelCollapsed(false));
    const shell = ui.querySelector<HTMLElement>('[data-mobile-shell]')!;
    assert.equal(shell.style.gridTemplateAreas, '"view pane" "bar bar"');
    assert.deepEqual({ ...panels(ui), paneTitle: null }, { host: 'side-pane', sheet: false, pane: 'side-pane', paneTitle: null, scrim: false, order: 'view pane bar' });
  });

  it('Flex Mode puts the viewport on the top segment and the Panels list inline in the bottom one, with no floating button', () => {
    setViewport(412, 960);
    setSegments(TABLETOP);
    const ui = renderViewerLayout();
    const shell = ui.querySelector<HTMLElement>('[data-mobile-shell]')!;
    assert.equal(shell.dataset.mobilePanelHost, 'segment');
    assert.equal(shell.classList.contains('fixed'), true, 'segment rects are window coordinates');
    assert.equal(shell.style.gridTemplateAreas, '"." "view" "." "pane" "bar"');
    assert.equal(shell.style.gridTemplateRows, '0px 470px 20px minmax(0, 1fr) auto', 'viewport row = top segment, the hinge an empty track');
    assert.equal(ui.querySelector('[data-mobile-pane-slot] [data-mobile-panel-list]') !== null, true, 'the list is inline in the bottom segment');
    assert.equal(ui.querySelector('[data-mobile-panels-launcher]') !== null, false, 'no floating Panels button over the model');
    const hierarchy = [...ui.querySelectorAll<HTMLButtonElement>('[data-mobile-panel-list] li > button')].find((b) => b.textContent?.trim() === 'Hierarchy');
    assert.ok(hierarchy);
    act(() => hierarchy.click());
    assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
    assert.deepEqual(panels(ui), { host: 'segment', sheet: false, pane: 'segment', paneTitle: 'Hierarchy', scrim: false, order: 'view pane bar' });
    assert.equal(ui.querySelector('[data-mobile-panel-list]') !== null, false, 'the open panel replaces the list');
  });

  it('a book fold (half-open Fold) puts the viewport in the left segment and the pane over the bar in the right one', () => {
    setViewport(830, 750);
    setSegments(BOOK);
    const ui = renderViewerLayout();
    const shell = ui.querySelector<HTMLElement>('[data-mobile-shell]')!;
    assert.equal(shell.style.gridTemplateAreas, '". view . pane" ". view . bar"');
    assert.equal(shell.style.gridTemplateColumns, '0px 405px 20px minmax(0, 1fr)');
  });

  it('folding and unfolding live keeps the open panel, the selection and the mounted viewport', () => {
    setViewport(412, 960);
    const ui = renderViewerLayout();
    act(() => {
      useViewerStore.getState().setRightPanelCollapsed(false);
      useViewerStore.setState({ selectedEntityId: 4242 });
    });
    const viewport = ui.querySelector('[data-mobile-viewport] > div');
    assert.equal(panels(ui).sheet, true);

    setSegments(TABLETOP);
    resizeTo(412, 960);
    assert.equal(panels(ui).pane, 'segment', 'folding moved the panel into the bottom segment');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
    assert.equal(useViewerStore.getState().selectedEntityId, 4242);
    assert.equal(ui.querySelector('[data-mobile-viewport] > div') === viewport, true, 'folding remounted the viewport');

    setSegments(null);
    resizeTo(960, 412);
    assert.equal(panels(ui).pane, 'side-pane', 'rotating an unfolded phone docks the panel beside the model');
    resizeTo(412, 960);
    assert.deepEqual({ sheet: panels(ui).sheet, pane: panels(ui).pane }, { sheet: true, pane: null });
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false, 'unfolding closed the panel');
    assert.equal(useViewerStore.getState().selectedEntityId, 4242);
    assert.equal(ui.querySelector('[data-mobile-viewport] > div') === viewport, true, 'unfolding remounted the viewport');
  });
});
