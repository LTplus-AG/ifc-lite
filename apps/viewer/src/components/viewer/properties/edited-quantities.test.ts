/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The "Updated from geometry" marker goes on the refreshed set only (#9026 item 20 follow-up). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRefreshedSet } from './edited-quantities';

const refreshed = { name: 'BaseQuantities', quantities: [{ name: 'Height', value: 4 }, { name: 'GrossVolume', value: 6.4 }] };

describe('the refreshed-set marker', () => {
  it('marks the refreshed set, and not a second set of the same name that keeps the file values', () => {
    assert.equal(isRefreshedSet({ ...refreshed, quantities: [...refreshed.quantities] }, refreshed), true);
    assert.equal(isRefreshedSet({ name: 'BaseQuantities', quantities: [{ name: 'Fixings', value: 2 }] }, refreshed), false);
    assert.equal(isRefreshedSet({ name: 'BaseQuantities', quantities: [{ name: 'Height', value: 3 }, { name: 'GrossVolume', value: 4.8 }] }, refreshed), false);
  });

  it('marks nothing when no set was refreshed', () => {
    assert.equal(isRefreshedSet(refreshed, null), false);
  });
});
