/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanFailureMessage } from './scan-validation-message.js';

test('unknown scan failures retain their runtime detail (#4918)', () => {
  assert.deepEqual(scanFailureMessage(new Error('device-specific detail')), {
    kind: 'raw',
    text: 'device-specific detail',
  });
});
