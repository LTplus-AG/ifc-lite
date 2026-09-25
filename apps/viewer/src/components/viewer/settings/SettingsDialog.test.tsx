/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5857 — one Settings dialog. `openSettings(section)` opens the mounted
 * host on that section; General writes through the same store actions as
 * the existing toggles; Display hosts the SpaceMouse controls that used to
 * be the Info dialog's Preferences tab (its removal is asserted in
 * KeyboardShortcutsDialog.i18n.test.tsx, which has the build defines).
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ComponentType } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';

// Dynamic: the revert oracle deletes these modules, and a static import would
// fail the whole file instead of letting the assertions go red.
let SettingsDialogHost: ComponentType | undefined;
let openSettings: ((section?: 'general' | 'display') => void) | undefined;
let settingsEn: Record<string, string> = {};
try {
  ({ SettingsDialogHost } = await import('./SettingsDialog.js'));
  ({ openSettings } = await import('@/lib/settings/open-settings'));
  ({ settingsEn } = await import('@/i18n/catalogues/settings.en'));
} catch (error) {
  console.error('[SettingsDialog.test] settings modules unavailable; assertions will fail', error instanceof Error ? error.message : error);
}

afterEach(() => {
  cleanup();
  act(() => useViewerStore.getState().setTheme('light'));
});

function mountAndOpen(section?: 'general' | 'display') {
  assert.ok(SettingsDialogHost && openSettings, 'SettingsDialogHost and openSettings must exist');
  const Host = SettingsDialogHost;
  render(<Host />);
  act(() => openSettings!(section));
  const dialog = document.querySelector('[data-settings-dialog]');
  assert.ok(dialog, 'openSettings() opens the dialog');
  return dialog as HTMLElement;
}

function activeSection(dialog: HTMLElement): string | null {
  return dialog.querySelector('[role="tab"][data-state="active"]')?.textContent ?? null;
}

describe('Settings dialog (#5857)', () => {
  it('opens on General by default', () => {
    const dialog = mountAndOpen();
    assert.equal(activeSection(dialog), settingsEn['settings.sections.general']);
  });

  it('opens on the section it is asked for, with the SpaceMouse controls under Display', () => {
    const dialog = mountAndOpen('display');
    assert.equal(activeSection(dialog), settingsEn['settings.sections.display']);
    assert.ok((dialog.textContent ?? '').includes(settingsEn['settings.display.spaceMouseTitle']));
  });

  it('General → Theme writes the store theme', () => {
    const dialog = mountAndOpen('general');
    const dark = [...dialog.querySelectorAll('[role="radio"]')].find((b) => b.textContent === settingsEn['settings.general.themeDark']);
    assert.ok(dark, 'a Dark theme choice is rendered');
    click(dark);
    assert.equal(useViewerStore.getState().theme, 'dark');
  });
});
