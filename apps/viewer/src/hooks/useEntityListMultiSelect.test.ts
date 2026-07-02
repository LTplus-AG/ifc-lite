/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveListSelection } from './useEntityListMultiSelect.js';

const NONE = { shiftKey: false, ctrlKey: false, metaKey: false };

describe('resolveListSelection (#1463)', () => {
  it('plain click selects a single row and sets the anchor', () => {
    assert.deepStrictEqual(resolveListSelection(null, 3, 10, NONE), { kind: 'single', index: 3 });
  });

  it('Ctrl/Cmd click toggles the row', () => {
    assert.deepStrictEqual(
      resolveListSelection(1, 4, 10, { ...NONE, ctrlKey: true }),
      { kind: 'toggle', index: 4 },
    );
    assert.deepStrictEqual(
      resolveListSelection(1, 4, 10, { ...NONE, metaKey: true }),
      { kind: 'toggle', index: 4 },
    );
  });

  it('Shift click selects the inclusive range from the anchor, either direction', () => {
    assert.deepStrictEqual(
      resolveListSelection(1, 4, 10, { ...NONE, shiftKey: true }),
      { kind: 'range', lo: 1, hi: 4 },
    );
    // Anchor below the click still yields an ordered [lo, hi].
    assert.deepStrictEqual(
      resolveListSelection(6, 2, 10, { ...NONE, shiftKey: true }),
      { kind: 'range', lo: 2, hi: 6 },
    );
  });

  it('Shift with no anchor falls back to a single select (no range to extend)', () => {
    assert.deepStrictEqual(
      resolveListSelection(null, 4, 10, { ...NONE, shiftKey: true }),
      { kind: 'single', index: 4 },
    );
  });

  it('Shift with a stale anchor outside the current list falls back to single', () => {
    // List shrank to 3 items; the old anchor (8) is no longer valid.
    assert.deepStrictEqual(
      resolveListSelection(8, 1, 3, { ...NONE, shiftKey: true }),
      { kind: 'single', index: 1 },
    );
  });

  it('Shift takes precedence over Ctrl when both are held', () => {
    assert.deepStrictEqual(
      resolveListSelection(0, 2, 10, { shiftKey: true, ctrlKey: true, metaKey: false }),
      { kind: 'range', lo: 0, hi: 2 },
    );
  });
});
