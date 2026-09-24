/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SpaceMouse settings moved out of a floating panel into Preferences →
 * Navigation (#5509). The ribbon's View tab no longer toggles a panel; it
 * deep-links the Info dialog to the Preferences tab via the same
 * `EVENT_SHOW_SHORTCUTS` window event `ViewerLayout` already listens for
 * (see `ViewportWelcomeCard.tsx`'s "about" deep link for the established
 * pattern). This proves the ribbon button emits that event with the right
 * tab, without mounting all of `ViewerLayout`.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';
import { ViewTab } from './ViewTab.js';

afterEach(() => {
  cleanup();
});

describe('ViewTab — SpaceMouse button opens Preferences (#5509)', () => {
  it('dispatches EVENT_SHOW_SHORTCUTS with tab "preferences" when clicked', () => {
    const container = render(<ViewTab />);
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Connect a 3Dconnexion SpaceMouse (WebHID)' || b.textContent?.includes('SpaceMouse'),
    );
    assert.ok(button, 'expected a SpaceMouse button on the View tab');

    const received: Array<{ tab?: string } | undefined> = [];
    const listener = (e: Event) => received.push((e as CustomEvent<{ tab?: string }>).detail);
    window.addEventListener(EVENT_SHOW_SHORTCUTS, listener);
    try {
      click(button!);
    } finally {
      window.removeEventListener(EVENT_SHOW_SHORTCUTS, listener);
    }

    assert.equal(received.length, 1, 'expected exactly one show-shortcuts event');
    assert.equal(received[0]?.tab, 'preferences');
  });
});
