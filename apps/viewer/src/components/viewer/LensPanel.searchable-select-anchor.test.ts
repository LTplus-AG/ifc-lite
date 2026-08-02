/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure positioning math for `SearchableSelect`'s portaled popup (#1924).
 *
 * `computeSearchableSelectAnchor` decides whether the popup opens down
 * (default) or flips up when there isn't enough room below the trigger —
 * the "flip near the bottom of a docked/floating panel" half of the fix
 * described in the issue. No DOM needed; this is plain arithmetic on a
 * trigger rect plus a viewport height.
 */

// `LensPanel.tsx` transitively imports the Zustand store, whose slices touch
// browser globals (localStorage, etc.) at module init — register happy-dom
// FIRST, same requirement as the rendering test alongside this one.
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSearchableSelectAnchor, resolveTriggerWindow } from './LensPanel.js';

describe('resolveTriggerWindow (#1958 follow-up)', () => {
  it('resolves the element\'s own window via ownerDocument.defaultView', () => {
    const el = document.createElement('div');
    const fakeWindow = { innerHeight: 42 };
    Object.defineProperty(el, 'ownerDocument', {
      value: { defaultView: fakeWindow },
      configurable: true,
    });
    assert.equal(resolveTriggerWindow(el), fakeWindow);
  });

  it('falls back to the global window when ownerDocument.defaultView is null (detached document)', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'ownerDocument', {
      value: { defaultView: null },
      configurable: true,
    });
    assert.equal(resolveTriggerWindow(el), window);
  });
});

describe('computeSearchableSelectAnchor (#1924)', () => {
  it('opens down when there is plenty of room below the trigger', () => {
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 100, bottom: 130 },
      /* viewportHeight */ 800,
    );
    assert.equal(anchor.openUp, false);
    assert.equal(anchor.top, 130, 'top anchors to the trigger bottom');
    assert.equal(anchor.left, 20);
    assert.equal(anchor.width, 200);
  });

  it('flips up when the trigger sits near the bottom of the viewport', () => {
    // Viewport is 800px tall; trigger bottom is at 780px, leaving only 20px
    // below it — far less than the popup's max-height (200px) — while 750px
    // of room exists above.
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 750, bottom: 780 },
      800,
    );
    assert.equal(anchor.openUp, true);
    assert.equal(anchor.bottom, 50, 'bottom anchors to (viewportHeight - trigger.top)');
  });

  it('does NOT flip up when there is even less room above than below (nowhere better to go)', () => {
    // Room below (800 - 650 = 150px) IS under the popup max-height (200px),
    // so the first condition (spaceBelow < popupMaxHeight) is true and the
    // `spaceAbove > spaceBelow` guard is the only thing left to decide the
    // result — it must be, or this test would pass even with the guard
    // deleted (verified: `{ top: 10, bottom: 40 }` against an 800 viewport
    // has spaceBelow = 760, so the first condition alone already forces
    // `openUp` false there regardless of the guard — see #1958 review).
    // Room above (30px) is smaller still, so the guard should also say no.
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 30, bottom: 650 },
      800,
    );
    assert.equal(anchor.openUp, false);
  });

  it('respects a custom popup max-height threshold', () => {
    // 60px of room below is enough for a 50px-tall popup, so it should NOT flip.
    const roomy = computeSearchableSelectAnchor(
      { left: 0, width: 100, top: 700, bottom: 740 },
      800,
      50,
    );
    assert.equal(roomy.openUp, false);

    // The same geometry with the default 200px popup height DOES flip.
    const cramped = computeSearchableSelectAnchor(
      { left: 0, width: 100, top: 700, bottom: 740 },
      800,
    );
    assert.equal(cramped.openUp, true);
  });
});
