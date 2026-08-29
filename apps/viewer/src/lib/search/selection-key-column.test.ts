/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage for the shared selection-key resolution used by both
 * `SearchModalFilter`'s row click (`selectionKeyIndex`) and
 * `filterResultToSearchResults`'s n/N-cycle bridge. The discriminating case
 * — both `express_id` and `entity_id` present, `entity_id` positioned
 * first — is what previously made the two call sites' own local copies of
 * this logic disagree (see `filter-result-to-search-results.test.ts`'s
 * "prefers express_id over entity_id ..." test for the bridge-level pin).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SELECTION_COLUMNS, selectionKeyColumnIndex } from './selection-key-column.js';

describe('selectionKeyColumnIndex', () => {
  it('picks express_id over entity_id when both are present, even when entity_id comes first', () => {
    assert.equal(selectionKeyColumnIndex(['entity_id', 'express_id', 'name']), 1);
  });

  it('picks whichever SELECTION_COLUMNS candidate is present when only one is', () => {
    assert.equal(selectionKeyColumnIndex(['express_id', 'name']), 0);
    assert.equal(selectionKeyColumnIndex(['entity_id', 'name']), 0);
  });

  it('returns -1 when no candidate column is present', () => {
    assert.equal(selectionKeyColumnIndex(['name', 'type']), -1);
  });

  it('SELECTION_COLUMNS is express_id before entity_id (the priority order the helper walks)', () => {
    assert.deepEqual(SELECTION_COLUMNS, ['express_id', 'entity_id']);
  });
});
