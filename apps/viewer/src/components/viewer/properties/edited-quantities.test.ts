/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The "Updated from geometry" marker goes on the refreshed set only (#9026 item 20 follow-up). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRefreshedSet } from './edited-quantities';

const refreshed = { name: 'BaseQuantities', globalId: '2xRefreshed00000000000a', quantities: [{ name: 'Height', value: 4 }] };

describe('the refreshed-set marker', () => {
  it('marks the refreshed set by its GlobalId, and not a second set of the same name', () => {
    assert.equal(isRefreshedSet({ name: 'BaseQuantities', globalId: '2xRefreshed00000000000a' }, refreshed), true);
    assert.equal(isRefreshedSet({ name: 'BaseQuantities', globalId: '3yTwin000000000000000b' }, refreshed), false);
    assert.equal(isRefreshedSet({ name: 'BaseQuantities' }, refreshed), false, 'a twin with no GlobalId is not the refreshed set');
  });

  it('keeps marking the refreshed set after a quantity in it is edited by hand', () => {
    const edited = { name: 'BaseQuantities', globalId: refreshed.globalId, quantities: [{ name: 'Height', value: 9 }] };
    assert.equal(isRefreshedSet(edited, refreshed), true);
  });

  it('matches by name when a malformed file gives its sets no GlobalId', () => {
    assert.equal(isRefreshedSet({ name: 'BaseQuantities' }, { name: 'BaseQuantities' }), true);
    assert.equal(isRefreshedSet({ name: 'Qto_WallBaseQuantities' }, { name: 'BaseQuantities' }), false);
  });

  it('marks nothing when no set was refreshed', () => {
    assert.equal(isRefreshedSet({ name: 'BaseQuantities', globalId: refreshed.globalId }, null), false);
  });
});
