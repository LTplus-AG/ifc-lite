/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Alt+1…0 row names the panels those keys actually open, as the registry
 * titles them (#5606: it still said "IDS" after the panel became "Data
 * validation", #5138).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS, workspacePanelForShortcutCode } from '@/lib/panels/registry';
import { KEYBOARD_SHORTCUTS } from './keyboard-shortcuts-list.js';

describe('Alt+1…0 shortcut description (#5606)', () => {
  const row = KEYBOARD_SHORTCUTS.find((s) => s.key === 'Alt+1…0');

  it('names every Alt-digit panel by its registry title, in key order', () => {
    assert.ok(row, 'the Alt+1…0 row exists');
    const codes = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => `Digit${d}`);
    const titles = codes.map((code) => {
      const id = workspacePanelForShortcutCode(code);
      const title = WORKSPACE_PANELS.find((p) => p.id === id)?.title;
      assert.ok(title, `${code} opens a registered panel`);
      return title;
    });
    let from = 0;
    for (const title of titles) {
      const at = row.description.indexOf(title, from);
      assert.ok(at >= from, `"${title}" appears in key order in: ${row.description}`);
      from = at + title.length;
    }
  });

  it('no longer names the retired IDS panel', () => {
    assert.ok(row);
    assert.doesNotMatch(row.description, /\bIDS\b/);
  });
});
