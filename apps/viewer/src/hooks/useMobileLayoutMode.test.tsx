/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5837: on a phone, the on-screen keyboard, the URL bar and rotation all fire
 * `resize`. The panels are collapsed when the layout ENTERS mobile mode, never
 * again while it stays mobile — otherwise focusing a field in the open sheet
 * opens the keyboard, and the keyboard closes the sheet.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { isMobileViewport, useMobileLayoutMode } from './useMobileLayoutMode.js';

function Harness() {
  useMobileLayoutMode();
  return null;
}

// A phone: rotation to 844px landscape stays mobile only because it has touch.
Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });

let root: Root | null = null;

async function mountAt(width: number, height: number): Promise<void> {
  await resizeTo(width, height, false);
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<Harness />); });
}

async function resizeTo(width: number, height: number, dispatch = true): Promise<void> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  if (dispatch) await act(async () => { window.dispatchEvent(new Event('resize')); });
}

function openSheet(): void {
  useViewerStore.getState().setRightPanelCollapsed(false);
}

function sheetOpen(): boolean {
  return !useViewerStore.getState().rightPanelCollapsed;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
});

describe('useMobileLayoutMode (#5837)', () => {
  it('collapses the panels when it mounts in mobile mode', async () => {
    openSheet();
    await mountAt(390, 844);
    assert.equal(useViewerStore.getState().isMobile, true);
    assert.equal(sheetOpen(), false);
    assert.equal(useViewerStore.getState().leftPanelCollapsed, true);
  });

  it('keeps an open sheet open when a resize stays mobile (keyboard, URL bar, rotation)', async () => {
    await mountAt(390, 844);
    openSheet();
    await resizeTo(390, 500); // on-screen keyboard opens
    assert.equal(sheetOpen(), true, 'the keyboard resize closed the sheet');
    await resizeTo(390, 780); // URL bar hides
    await resizeTo(844, 390); // rotation to landscape, still a phone
    assert.equal(useViewerStore.getState().isMobile, true);
    assert.equal(sheetOpen(), true, 'a resize inside mobile mode closed the sheet');
  });

  it('collapses once on a real desktop -> mobile switch', async () => {
    await mountAt(1440, 900);
    assert.equal(useViewerStore.getState().isMobile, false);
    openSheet();
    await resizeTo(1280, 900); // desktop -> desktop: untouched
    assert.equal(sheetOpen(), true);
    await resizeTo(600, 900); // desktop -> mobile
    assert.equal(useViewerStore.getState().isMobile, true);
    assert.equal(sheetOpen(), false);
    openSheet();
    await resizeTo(600, 500);
    assert.equal(sheetOpen(), true);
  });
});

describe('isMobileViewport', () => {
  it('is mobile below 768px, and below 1024px on a touch screen', () => {
    assert.equal(isMobileViewport(767, false), true);
    assert.equal(isMobileViewport(768, false), false);
    assert.equal(isMobileViewport(1023, true), true);
    assert.equal(isMobileViewport(1024, true), false);
  });
});
