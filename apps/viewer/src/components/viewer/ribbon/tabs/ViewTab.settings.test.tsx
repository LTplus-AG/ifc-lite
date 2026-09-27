/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ribbon's View tab opens Settings (#5857): its SpaceMouse button deep-
 * links Settings → Display (where the device controls moved from the Info
 * dialog's Preferences tab, #5509), and a Settings button opens it on the
 * first section. Both go through the one `ifc-lite:open-settings` event that
 * `SettingsDialogHost` listens for, asserted here without mounting
 * `ViewerLayout`.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { ribbonToolbarEn } from '@/i18n/catalogues/ribbon-toolbar.en';
import { ViewTab } from './ViewTab.js';

const EVENT_OPEN_SETTINGS = 'ifc-lite:open-settings';

afterEach(() => {
  cleanup();
});

function capture(run: () => void): Array<{ section?: string } | undefined> {
  const received: Array<{ section?: string } | undefined> = [];
  const listener = (e: Event) => received.push((e as CustomEvent<{ section?: string }>).detail);
  window.addEventListener(EVENT_OPEN_SETTINGS, listener);
  try {
    run();
  } finally {
    window.removeEventListener(EVENT_OPEN_SETTINGS, listener);
  }
  return received;
}

function buttonLabelled(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  );
}

describe('ViewTab opens Settings (#5857)', () => {
  it('the SpaceMouse button opens Settings on the Display section', () => {
    const container = render(<ViewTab />);
    const button = buttonLabelled(container, ribbonToolbarEn['ribbon.view.spaceMouse']);
    assert.ok(button, 'expected a SpaceMouse button on the View tab');
    assert.deepEqual(capture(() => click(button)), [{ section: 'display' }]);
  });

  it('a Settings button opens Settings on its first section', () => {
    const container = render(<ViewTab />);
    const label = (ribbonToolbarEn as Record<string, string>)['ribbon.view.settings'];
    assert.equal(typeof label, 'string', 'ribbon.view.settings must be a catalogue string');
    const button = buttonLabelled(container, label);
    assert.ok(button, 'expected a Settings button on the View tab');
    assert.deepEqual(capture(() => click(button)), [{ section: undefined }]);
  });
});
