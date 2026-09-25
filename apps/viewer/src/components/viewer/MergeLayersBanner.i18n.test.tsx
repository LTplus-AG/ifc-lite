/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { registerLocale, setLocale } from '@/i18n';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud';
import { MergeLayersBanner } from './MergeLayersBanner';

/**
 * `MergeLayersBanner` portals into `ViewportHud`'s top-center region
 * (#5504); mount the HUD host alongside it, or `HudItem` renders nothing.
 */
function renderBanner(): HTMLElement {
  return render(<><ViewportHud /><MergeLayersBanner /></>);
}

beforeEach(() => {
  act(() => {
    useViewerStore.setState({ mergeLayersPendingReload: true, mergeLayers: true });
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  act(() => {
    useViewerStore.setState({ mergeLayersPendingReload: false, mergeLayers: false });
  });
});

it('renders the English catalogue value by default (#4785)', () => {
  const container = renderBanner();
  const status = container.querySelector('[role="status"]');
  assert.ok(status?.textContent?.includes('Merge Multilayer Walls enabled'));
  assert.ok(status?.textContent?.includes('Reload model to apply the new setting.'));
  const reloadButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Reload'),
  );
  assert.ok(reloadButton, 'expected a Reload button');
});

it('renders a registered locale value when present, and falls back to English for a key that locale omits (#4785)', () => {
  // 'de' translates the title but deliberately does not cover the subtitle —
  // that key must still surface in English, not blank.
  registerLocale('de', { 'mergeLayersBanner.titleEnabled': 'Mehrschichtige Wände zusammenführen aktiviert' });
  setLocale('de');
  const container = renderBanner();
  const status = container.querySelector('[role="status"]');
  assert.ok(status?.textContent?.includes('Mehrschichtige Wände zusammenführen aktiviert'));
  // Fallback: English subtitle, not an empty string.
  assert.ok(status?.textContent?.includes('Reload model to apply the new setting.'));
});
