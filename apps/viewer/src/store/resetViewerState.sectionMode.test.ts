/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #2939: "a section position is pre-chosen from stale cache."
 *
 * `SectionPanel.tsx` restores the section tool's last-used mode from
 * `localStorage` (`ifc-lite:section-last-mode`, `sectionSlice.ts`'s
 * `loadLastSectionMode`) whenever the panel mounts. For a 'cardinal' entry
 * that restore includes `position` — a percentage along the LOADED MODEL's
 * bounding box, i.e. geometry, not a UI preference. It is only meaningful
 * relative to whichever model was on screen when it was saved.
 *
 * That entry lives in `localStorage`, so it survives closing the browser —
 * unlike the in-memory `sectionPlane.axis/position/flipped` fields, which
 * `resetViewerState()` already resets to defaults on every new file load
 * (`store/index.ts`, "Section plane" block). Before this fix,
 * `resetViewerState()` never touched the localStorage copy: opening the
 * section tool on a freshly loaded, UNRELATED model would read yesterday's
 * cardinal position back out of storage and apply it immediately — the
 * tool looked like it "pre-chose" a cut instead of arming face-pick mode.
 *
 * This is a real, unmocked `useViewerStore` (not a hand-rolled slice mock)
 * combined with a real `window.localStorage` (via `@/test/setup-dom.js`),
 * driving the actual persistence layer end to end: save a cardinal mode as
 * if a session with "model A" had set one, then call `resetViewerState()`
 * — the exact function every primary file load invokes before loading
 * "model B" — and confirm the stale entry cannot be read back.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore, loadLastSectionMode } from './index.js';

describe('resetViewerState — drops the persisted cross-session section mode (#2939)', () => {
  it('a cardinal mode saved for one model is not read back after resetViewerState() (simulating a new file load)', () => {
    // Simulate "model A" session: user cuts a cardinal section, off-center,
    // which the slice's own setter persists to localStorage.
    const s = useViewerStore.getState();
    s.setSectionPlaneAxis('front');
    s.setSectionPlanePosition(73);
    assert.deepStrictEqual(loadLastSectionMode(), {
      kind: 'cardinal', axis: 'front', position: 73, flipped: false,
    }, 'precondition: the cardinal mode round-trips through localStorage');

    // Every primary file load calls this before loading the new file
    // (`useIfcLoader.ts`: "if (target.kind === 'primary') { resetViewerState(); ... }").
    // Simulates opening "model B" in the SAME browser session — or, since
    // this entry is in localStorage, closing and reopening the browser
    // entirely before opening a different file.
    useViewerStore.getState().resetViewerState();

    // The next mount of SectionPanel must NOT resurrect model A's cardinal
    // position for model B — it must fall back to the 'pick' default so
    // face-pick mode arms instead of a stale cut appearing pre-chosen.
    assert.deepStrictEqual(
      loadLastSectionMode(),
      { kind: 'pick' },
      'resetViewerState() must clear the persisted cardinal mode, not just the in-memory sectionPlane fields'
    );

    // The in-memory fields are reset too (already covered elsewhere, but
    // pinned here so this file alone demonstrates BOTH copies of the state
    // are dropped together, per the slice's own doc comment).
    const after = useViewerStore.getState().sectionPlane;
    assert.strictEqual(after.axis, 'down');
    assert.strictEqual(after.position, 50);
    assert.strictEqual(after.enabled, false);
  });

  it('leaves the persistent cap-appearance preferences alone (they are display style, not geometry)', () => {
    const s = useViewerStore.getState();
    s.setSectionCapStyle({ spacingPx: 12 });
    s.setSectionShowCap(false);

    useViewerStore.getState().resetViewerState();

    const after = useViewerStore.getState().sectionPlane;
    assert.strictEqual(after.capStyle.spacingPx, 12, 'cap style is a UI preference, must survive a model swap');
    assert.strictEqual(after.showCap, false, 'showCap is a UI preference, must survive a model swap');
  });
});
