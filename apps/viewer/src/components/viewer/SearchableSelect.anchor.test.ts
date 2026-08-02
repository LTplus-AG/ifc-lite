/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure positioning math for `SearchableSelect`'s portaled popup (#1924).
 *
 * `computeSearchableSelectAnchor` decides whether the popup opens down
 * (default) or flips up when there isn't enough room below the trigger —
 * the "flip near the bottom of a docked/floating panel" half of the fix
 * described in the issue — and clamps the popup's height to whatever space
 * is actually available on the side it opens toward (#1958 review). No DOM
 * needed; this is plain arithmetic on a trigger rect plus a viewport height.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSearchableSelectAnchor, resolveTriggerWindow } from './SearchableSelect.js';

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

describe('computeSearchableSelectAnchor maxHeight clamp (#1958 review)', () => {
  it('clamps the popup height so a flip-up cannot push its top (the filter input, for >8 options) off-screen', () => {
    // Maintainer's exact scenario: a 300px-tall trigger window, trigger at
    // top 160 / bottom 190. spaceBelow = 110, spaceAbove = 160 — spaceBelow
    // < popupMaxHeight (200) and spaceAbove > spaceBelow, so it flips up.
    // Unclamped, the popup would anchor at `bottom: 142` and extend upward
    // by the full 200px max-height, i.e. from y=158 to y=-42 — the top 42px
    // (the filter input, for >8 options) would sit above the viewport, and
    // because the popup is `position: fixed`, nothing could scroll it back.
    const viewportHeight = 300;
    const anchor = computeSearchableSelectAnchor(
      { left: 0, width: 120, top: 160, bottom: 190 },
      viewportHeight,
    );
    assert.equal(anchor.openUp, true, 'flips up in this scenario');

    // The popup's fixed `bottom` offset (see SearchableSelect.tsx's inline
    // style: `bottom: anchor.bottom + 2`) plus its clamped height gives the
    // popup's top edge, measured from the viewport top. It must be >= 0 —
    // i.e. the filter input stays on-screen.
    const fixedBottom = anchor.bottom + 2;
    const topEdge = viewportHeight - fixedBottom - anchor.maxHeight;
    assert.ok(
      topEdge >= 0,
      `popup top edge must be on-screen (>= 0), got ${topEdge} (anchor.maxHeight=${anchor.maxHeight}, anchor.bottom=${anchor.bottom})`,
    );
  });

  it('clamps to the popup max-height when there is abundant space (no clamping needed)', () => {
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 500, bottom: 530 },
      800,
    );
    assert.equal(anchor.openUp, false);
    assert.equal(anchor.maxHeight, 200, 'plenty of room below — height is the popup max-height, not clamped down');
  });

  it('also clamps the not-flipped case when space below is tight', () => {
    // spaceBelow = 800 - 650 = 150, which is under the 200px popup max-height,
    // but spaceAbove (30) is even smaller, so it doesn't flip (per the
    // existing "does NOT flip up" test above) — it stays open-down, and the
    // clamp should still cap the height to the (tight) space below rather
    // than the full 200px, so the popup doesn't overflow the viewport bottom.
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 30, bottom: 650 },
      800,
    );
    assert.equal(anchor.openUp, false);
    assert.ok(anchor.maxHeight <= 150, `expected maxHeight clamped to <= 150 (spaceBelow), got ${anchor.maxHeight}`);
  });
});
