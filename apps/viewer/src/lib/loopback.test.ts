/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isLoopbackHostname } from './loopback.js';

describe('isLoopbackHostname', () => {
  it('covers localhost, all of 127.0.0.0/8 and [::1], as browsers treat them', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '127.255.255.254', '[::1]']) {
      assert.equal(isLoopbackHostname(host), true, host);
    }
  });

  it('does not treat look-alikes as loopback', () => {
    for (const host of ['127.example.org', '128.0.0.1', '1127.0.0.1', 'localhost.example.org', '::1']) {
      assert.equal(isLoopbackHostname(host), false, host);
    }
  });
});
