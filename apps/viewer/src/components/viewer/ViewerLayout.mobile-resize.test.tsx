/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5837: on a phone, the on-screen keyboard, the URL bar and rotation all fire
 * `resize`. `ViewerLayout` collapses the panels when the layout ENTERS mobile
 * mode, never again while it stays mobile. Otherwise focusing a field in the
 * open sheet opens the keyboard, and the keyboard closes the sheet.
 *
 * Renders the real layout so the assertion is on what the user sees (the sheet
 * flag the layout reads), whichever module owns the resize listener.
 */

import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { activate, cleanup } from '@/test/render.js';
import { renderViewerLayout } from '@/test/viewer-layout-harness.js';
import { useViewerStore } from '@/store';
import { clearRetiredToolbarStylePreference, TOOLBAR_STYLE_STORAGE_KEY } from '@/store/constants';

const ORIGINAL = { width: window.innerWidth, height: window.innerHeight };

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function resizeTo(width: number, height: number): void {
  setViewport(width, height);
  act(() => { window.dispatchEvent(new Event('resize')); });
}

function openSheet(): void {
  act(() => useViewerStore.getState().setRightPanelCollapsed(false));
}

const sheetOpen = () => !useViewerStore.getState().rightPanelCollapsed;
const isMobile = () => useViewerStore.getState().isMobile;

// A phone: rotation to 844px landscape stays mobile only because it has touch.
Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });

const RESET = { isMobile: false, leftPanelCollapsed: true, rightPanelCollapsed: true };

beforeEach(() => useViewerStore.setState(RESET));

afterEach(() => {
  cleanup();
  setViewport(ORIGINAL.width, ORIGINAL.height);
  useViewerStore.setState(RESET);
});

describe('ViewerLayout desktop split (#5873)', () => {
  it('#5873 reserves enough default desktop split for hierarchy names beside the grouped rail', () => {
    setViewport(1600, 1000);
    useViewerStore.setState({ leftPanelCollapsed: false });
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    // Happy DOM reports zero layout width. Give the real panel group a desktop
    // measurement so its own sizing algorithm applies the configured split.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.id === 'left-panel') return 350;
        if (this.id === 'viewport-panel') return 1200;
        return originalOffsetWidth?.get?.call(this) ?? 0;
      },
    });
    try {
      const ui = renderViewerLayout();
      const hierarchy = ui.querySelector<HTMLElement>('#left-panel');
      const viewport = ui.querySelector<HTMLElement>('#viewport-panel');
      assert.ok(hierarchy && viewport, 'the desktop hierarchy and viewport are both mounted');

      const hierarchySize = Number.parseFloat(hierarchy.style.flexGrow);
      const viewportSize = Number.parseFloat(viewport.style.flexGrow);
      assert.ok(hierarchySize >= 22.5, `hierarchy received only ${hierarchySize}%`);
      assert.ok(Math.abs(hierarchySize + viewportSize - 100) < 0.01, 'the initial split must total 100%');
    } finally {
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
      else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    }
  });
});

describe('ViewerLayout mobile panel collapse (#5837)', () => {
  it('#5874 opens the ribbon for a stored classic preference and clears that preference', () => {
    setViewport(1280, 900);
    localStorage.setItem(TOOLBAR_STYLE_STORAGE_KEY, 'classic');
    clearRetiredToolbarStylePreference();
    assert.equal(localStorage.getItem(TOOLBAR_STYLE_STORAGE_KEY), null);

    const ui = renderViewerLayout();
    assert.ok(ui.querySelector('[data-tour="ribbon-tabs"]'), 'the desktop renders ribbon tabs');
  });

  it('#5823 closes an open mobile sheet when its backdrop is keyboard-activated', () => {
    setViewport(390, 844);
    const ui = renderViewerLayout();
    openSheet();
    const backdrop = ui.querySelector<HTMLButtonElement>('button[aria-label="Close panels"]');
    assert.ok(backdrop, 'mobile backdrop must be a named button');
    activate(backdrop, 'Enter');
    assert.equal(sheetOpen(), false);
  });

  it('collapses the panels when it mounts in mobile mode', () => {
    useViewerStore.setState({ leftPanelCollapsed: false, rightPanelCollapsed: false });
    setViewport(390, 844);
    renderViewerLayout();
    assert.equal(isMobile(), true);
    assert.equal(sheetOpen(), false);
    assert.equal(useViewerStore.getState().leftPanelCollapsed, true);
  });

  it('keeps an open sheet open while resizes stay mobile (keyboard, URL bar, rotation)', () => {
    setViewport(390, 844);
    renderViewerLayout();
    openSheet();
    resizeTo(390, 500); // on-screen keyboard opens
    assert.equal(sheetOpen(), true, 'the keyboard resize closed the sheet');
    resizeTo(390, 780); // URL bar hides
    resizeTo(844, 390); // rotation to landscape, still a phone
    assert.equal(isMobile(), true);
    assert.equal(sheetOpen(), true, 'a resize inside mobile mode closed the sheet');
  });

  it('collapses once on a real desktop -> mobile switch, and not again', () => {
    setViewport(1440, 900);
    renderViewerLayout();
    assert.equal(isMobile(), false);
    openSheet();
    resizeTo(1280, 900); // desktop -> desktop: untouched
    assert.equal(sheetOpen(), true);
    resizeTo(600, 900); // desktop -> mobile
    assert.equal(isMobile(), true);
    assert.equal(sheetOpen(), false);
    openSheet();
    resizeTo(600, 500);
    assert.equal(sheetOpen(), true, 'a second mobile resize closed the sheet');
  });
});
