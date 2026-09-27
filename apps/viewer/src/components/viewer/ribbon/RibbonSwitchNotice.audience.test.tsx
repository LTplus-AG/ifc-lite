/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5840 — "the toolbar changed" is only for someone who saw the old one.
 * A first-time visitor (no history on this browser) never gets the notice,
 * and stays "new" even after opening files; a visitor whose recent-file
 * history predates the first ribbon render still gets it.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { ribbonToolbarEn } from '@/i18n/catalogues/ribbon-toolbar.en';
import { RibbonSwitchNotice } from './RibbonSwitchNotice.js';

const MESSAGE = ribbonToolbarEn['ribbon.notice.message'] as string;
const RECENT_KEY = 'ifc-lite:recent-files';

function seedRecentFile() {
  localStorage.setItem(RECENT_KEY, JSON.stringify([{ name: 'old.ifc', size: 1, timestamp: 1 }]));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('ribbon switch notice audience (#5840)', () => {
  it('is not shown to a first-time visitor', () => {
    const container = render(<RibbonSwitchNotice />);
    assert.ok(!(container.textContent ?? '').includes(MESSAGE), 'a new visitor must not see "the toolbar changed"');
  });

  it('stays hidden after a new visitor builds up history', () => {
    render(<RibbonSwitchNotice />);
    cleanup();
    seedRecentFile();
    const container = render(<RibbonSwitchNotice />);
    assert.ok(!(container.textContent ?? '').includes(MESSAGE));
  });

  it('is shown to a visitor with history from before the ribbon', () => {
    seedRecentFile();
    const container = render(<RibbonSwitchNotice />);
    assert.ok((container.textContent ?? '').includes(MESSAGE), 'a returning visitor is told the toolbar moved');
  });
});
