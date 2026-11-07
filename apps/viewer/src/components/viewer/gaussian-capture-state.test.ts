/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { gaussianStateLabel } from './gaussian-capture-state.js';

it('each terminal failure names its fix before the reload; renderer replacement is explicit (#8566)', () => {
  assert.equal(gaussianStateLabel({ state: 'failed', reason: 'anchor-extent' }).key, 'gaussianCapture.state.failedAnchor');
  assert.equal(gaussianStateLabel({ state: 'failed', reason: 'reload-required' }).key, 'gaussianCapture.state.failedReload');
  assert.deepEqual(gaussianStateLabel({ state: 'failed', reason: 'resource-limit' }), { key: 'gaussianCapture.state.failedOther', values: { reason: 'resource-limit' } });
  assert.equal(gaussianStateLabel({ state: 'invalid', reason: 'renderer-replaced' }).key, 'gaussianCapture.state.replaced');
  assert.equal(gaussianStateLabel({ state: 'pending' }).key, 'gaussianCapture.state.pending');
});
