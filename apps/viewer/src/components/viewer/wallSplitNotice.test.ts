/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `formatOpeningReassignSuffix`, the pure half of the wall-split notices
 * (`wallSplitNotice.ts`). The emitted toasts — including the
 * skipped-openings warning `reassignWallOpenings` reports (#3023) — are
 * pinned on both commit paths of the `element.split` command: the click
 * (`lib/commands/modeling/commands/element-split.test.ts`) and the typed
 * distance (`tools/SplitCursorInput.wallSplitToast.test.tsx`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatOpeningReassignSuffix } from './wallSplitNotice.js';

describe('formatOpeningReassignSuffix (pure)', () => {
  it('renders a count when openings moved', () => {
    assert.equal(formatOpeningReassignSuffix({ toLeft: 1, toRight: 2, skipped: 0 }), ' (3 openings reassigned)');
    assert.equal(formatOpeningReassignSuffix({ toLeft: 1, toRight: 0, skipped: 0 }), ' (1 opening reassigned)');
  });

  it('renders nothing when no openings moved', () => {
    assert.equal(formatOpeningReassignSuffix({ toLeft: 0, toRight: 0, skipped: 0 }), '');
    assert.equal(formatOpeningReassignSuffix({ toLeft: 0, toRight: 0, skipped: 3 }), '');
  });
});
