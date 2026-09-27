/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenChannelAfterReset } from './lens-reset';

it('Home retains manual ownership when a new lens match has not synced yet (#5877)', () => {
  const manual = 1;
  const owned = 2;
  const newMatch = 3;
  const result = hiddenChannelAfterReset(
    'lens', new Set([manual, owned, newMatch]), [owned], new Set([manual, owned]),
  );

  assert.deepEqual(result.hiddenEntities, new Set([manual, owned, newMatch]));
  assert.deepEqual(result.lensAppliedHiddenIds, [owned, newMatch],
    'manual overlap stays unowned, while a newly introduced hide belongs to the lens');
});
