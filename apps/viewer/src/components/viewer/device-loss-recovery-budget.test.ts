/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryBudget, RECOVERY_BUDGET_MAX, RECOVERY_BUDGET_WINDOW_MS } from './device-loss-recovery.js';

describe('createRecoveryBudget', () => {
  it('admits up to the limit per rolling window, then again once it has passed', () => {
    let now = 0;
    const admit = createRecoveryBudget(() => now);
    for (let i = 0; i < RECOVERY_BUDGET_MAX; i++) assert.equal(admit(), true);
    assert.equal(admit(), false);
    now = RECOVERY_BUDGET_WINDOW_MS;
    assert.equal(admit(), true, 'a GPU that recovers for a minute earns automatic recovery back');
  });
});
