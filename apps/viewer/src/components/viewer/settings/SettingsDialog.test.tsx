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
import { advance, cleanup, click, press, render } from '@/test/render.js';
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
  useViewerStore.setState({ navigationPreset: 'default' });
  localStorage.removeItem('ifc-lite-navigation-preset');
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
    const dark = [...dialog.querySelectorAll('label')].find((l) => l.textContent === settingsEn['settings.general.themeDark'])?.querySelector('input[type="radio"]');
    assert.ok(dark, 'a Dark theme radio is rendered');
    click(dark);
    assert.equal(useViewerStore.getState().theme, 'dark');
  });

  it('#5874 keeps General settings while retiring the toolbar-style choice', () => {
    const dialog = mountAndOpen('general');
    assert.ok(dialog.querySelector('#settings-theme'), 'General still has its theme control');
    assert.equal(dialog.querySelector('#settings-toolbar'), null);
  });

  it('Display → performance stats defaults off and toggles the persisted setting (#5868)', () => {
    assert.equal(useViewerStore.getState().showPerformanceStats, false);
    const dialog = mountAndOpen('display');
    const toggle = dialog.querySelector<HTMLElement>('#settings-performance-stats');
    assert.ok(toggle, 'Display settings show the performance toggle');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    click(toggle);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(useViewerStore.getState().showPerformanceStats, true);
    assert.equal(localStorage.getItem('ifc-lite:show-performance-stats'), 'true');
    act(() => useViewerStore.getState().setShowPerformanceStats(false));
  });

  it('Display → Trackpad saves the navigation choice used by the canvas (#5889)', () => {
    const dialog = mountAndOpen('display');
    const trackpad = [...dialog.querySelectorAll('label')]
      .find((label) => label.textContent === settingsEn['settings.display.preset.trackpad'])
      ?.querySelector('input[type="radio"]');
    assert.ok(trackpad, 'the Trackpad preset is selectable');
    click(trackpad);
    assert.equal(useViewerStore.getState().navigationPreset, 'trackpad');
    assert.equal(localStorage.getItem('ifc-lite-navigation-preset'), 'trackpad');
  });
  // #8802: on a phone the sections are a horizontal strip, so Left/Right move
  // between them; the desktop side list keeps Up/Down. Both stay real tabs.
  for (const { width, orientation, next } of [
    { width: 390, orientation: 'horizontal', next: 'ArrowRight' },
    { width: 1024, orientation: 'vertical', next: 'ArrowDown' },
  ] as const) {
    it(`section tabs follow the ${orientation} layout at ${width}px with ${next} (#8802)`, async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: /min-width:\s*(\d+)px/.test(query) ? width >= Number(/min-width:\s*(\d+)px/.exec(query)![1]) : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof window.matchMedia;
      try {
        const dialog = mountAndOpen('general');
        const list = dialog.querySelector<HTMLElement>('[role="tablist"]');
        assert.equal(list?.getAttribute('aria-orientation'), orientation);
        const active = dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        assert.ok(active, 'a selected tab');
        active.focus();
        press(active, next);
        await advance(0);
        assert.equal(activeSection(dialog), settingsEn['settings.sections.display'], `${next} selects the next section`);
        assert.equal(document.activeElement?.getAttribute('role'), 'tab');
      } finally {
        window.matchMedia = original;
      }
    });
  }
  // #8802: the phone strip fades the edge that hides more tabs, so a strip
  // that ends exactly at a tab boundary still reads as scrollable.
  it('the section strip fades whichever edge hides tabs (#8802)', () => {
    const proto = HTMLElement.prototype;
    const saved = ['scrollWidth', 'clientWidth'].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const);
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return this.getAttribute('role') === 'tablist' ? 600 : 0; } });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return this.getAttribute('role') === 'tablist' ? 300 : 0; } });
    try {
      const dialog = mountAndOpen('general');
      const list = dialog.querySelector<HTMLElement>('[role="tablist"]');
      assert.ok(list, 'the section tab list');
      assert.equal(list.getAttribute('data-scroll-fade'), 'end', 'at the start, the end edge hides tabs');
      act(() => { list.scrollLeft = 150; list.dispatchEvent(new Event('scroll')); });
      assert.equal(list.getAttribute('data-scroll-fade'), 'both');
      act(() => { list.scrollLeft = 300; list.dispatchEvent(new Event('scroll')); });
      assert.equal(list.getAttribute('data-scroll-fade'), 'start');
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    }
  });
});
