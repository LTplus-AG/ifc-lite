/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ClassVisibilityMenuContent } from '@/components/viewer/toolbar/ClassVisibilityMenu.js';
import { openSettings } from '@/lib/settings/open-settings';
import { GEOM_WORKERS_STORAGE_KEY, getGeomWorkerOverride } from '@/store/geomWorkerOverride';
import { GEOM_TIER_STORAGE_KEY, getGeomTierOverride } from '@/store/geometryFidelity';
import { useViewerStore } from '@/store';
import { SettingsDialogHost } from './SettingsDialog.js';

afterEach(() => {
  cleanup();
  localStorage.removeItem(GEOM_WORKERS_STORAGE_KEY);
  localStorage.removeItem(GEOM_TIER_STORAGE_KEY);
  window.history.replaceState(null, '', '/');
  useViewerStore.setState({ geomTierOverride: undefined, geometryMode: 'fast', geometryModePendingReload: false });
});

function openPerformance(): HTMLElement {
  render(<SettingsDialogHost />);
  act(() => openSettings('performance'));
  const dialog = document.querySelector<HTMLElement>('[data-settings-dialog]');
  assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Sticky geometry overrides/);
  return dialog;
}

function reset(dialog: HTMLElement, name: string): void {
  const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.getAttribute('aria-label') === `Reset ${name}`);
  assert.ok(button, `Reset ${name} is available`);
  click(button);
}

it('#5860 saved worker override is visible in Performance and Reset restores automatic workers', () => {
  localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, '4');
  const dialog = openPerformance();
  assert.match(dialog.textContent ?? '', /Geometry workers: 4/);
  assert.match(dialog.textContent ?? '', /Saved in this browser/);
  reset(dialog, 'Geometry workers');
  assert.equal(localStorage.getItem(GEOM_WORKERS_STORAGE_KEY), null);
  assert.equal(getGeomWorkerOverride(), undefined);
  assert.doesNotMatch(dialog.textContent ?? '', /Geometry workers: 4/);
});

it('#5860 Reset removes the originating URL parameter so an override cannot return', () => {
  window.history.replaceState(null, '', '/?geomWorkers=4&other=keep');
  const dialog = openPerformance();
  assert.match(dialog.textContent ?? '', /From this URL/);
  reset(dialog, 'Geometry workers');
  assert.equal(window.location.search, '?other=keep');
  assert.equal(getGeomWorkerOverride(), undefined);
});

it('#5860 geometry detail Reset uses the existing store action and removes its URL pin', () => {
  window.history.replaceState(null, '', '/?geomTier=low&other=keep');
  localStorage.setItem(GEOM_TIER_STORAGE_KEY, 'low');
  useViewerStore.setState({ geomTierOverride: 'low', geometryMode: 'exact' });
  const dialog = openPerformance();
  assert.match(dialog.textContent ?? '', /Geometry detail: low/);
  assert.match(dialog.textContent ?? '', /Low detail is ignored in Exact mode/);
  reset(dialog, 'Geometry detail');
  assert.equal(useViewerStore.getState().geomTierOverride, undefined);
  assert.equal(window.location.search, '?other=keep');
  assert.equal(getGeomTierOverride(), undefined);
});

it('#5860 the pinned-detail notice opens Settings → Performance', () => {
  useViewerStore.setState({ geomTierOverride: 'low' });
  render(<>
    <SettingsDialogHost />
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Visibility</DropdownMenuTrigger>
      <ClassVisibilityMenuContent />
    </DropdownMenu>
  </>);
  const entry = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('Performance settings'));
  assert.ok(entry);
  click(entry);
  const dialog = document.querySelector('[data-settings-dialog]');
  assert.ok(dialog);
  assert.equal(dialog.querySelector('[role="tab"][data-state="active"]')?.textContent, 'Performance');
});
