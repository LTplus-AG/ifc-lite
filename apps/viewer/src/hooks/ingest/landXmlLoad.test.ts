/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { awaitLandXmlFinalization } from './landXmlLoad.js';

it('rolls back both streamed ownership transactions when cancellation wins during suspended finalization (#5050)', async () => {
  let resolveFinalization: (() => void) | undefined;
  const finalization = new Promise<void>((resolve) => { resolveFinalization = resolve; });
  let current = true;
  let provisionalRollbacks = 0;
  let federatedRollbacks = 0;
  const pending = awaitLandXmlFinalization(
    finalization,
    () => current,
    { rollback: () => { provisionalRollbacks++; } },
    { rollback: () => { federatedRollbacks++; } },
  );
  current = false;
  resolveFinalization?.();
  assert.equal(await pending, false);
  assert.equal(provisionalRollbacks, 1);
  assert.equal(federatedRollbacks, 1);
});
