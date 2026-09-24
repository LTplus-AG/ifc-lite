/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5846: a key hint in a mobile nav tooltip must name the key that does that
 * action. The zoom buttons said "Zoom In (+)" / "Zoom Out (-)", but + and −
 * add to and remove from the basket (no key zooms the camera), so following
 * the hint changed the visible set instead of zooming.
 *
 * Oracle: the shortcut list the keyboard-shortcuts dialog shows. A hinted key
 * must be bound there, and its action must be the one the tooltip labels.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { viewportLightingEn } from '@/i18n/catalogues/viewport-lighting.en';
import { KEYBOARD_SHORTCUTS } from '@/hooks/keyboard-shortcuts-list';

const PREFIX = 'viewportLighting.overlays.mobileNav.';
const normalizeKey = (key: string) => key.replace('−', '-').toLowerCase();

describe('mobile nav tooltip key hints (#5846)', () => {
  it('name only keys bound to the action the tooltip labels', () => {
    let checked = 0;
    for (const [id, value] of Object.entries(viewportLightingEn)) {
      if (!id.startsWith(PREFIX) || typeof value !== 'string') continue;
      const hint = /^(.+) \(([^()]+)\)$/.exec(value);
      if (!hint) continue;
      const [, label, key] = hint;
      const shortcut = KEYBOARD_SHORTCUTS.find((s) => normalizeKey(s.key) === normalizeKey(key));
      assert.ok(shortcut, `${id} ("${value}") hints ${key}, which no shortcut binds`);
      const action = label.split(' ')[0].toLowerCase();
      assert.ok(
        shortcut.description.toLowerCase().startsWith(action),
        `${id} ("${value}") hints ${key}, but ${key} is "${shortcut.description}"`,
      );
      checked++;
    }
    assert.ok(checked > 0, 'no hinted tooltip was checked: the oracle is vacuous');
  });
});
