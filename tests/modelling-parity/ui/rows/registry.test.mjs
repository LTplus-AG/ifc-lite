/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistry } from './registry.mjs';
import { PROBES } from './index.mjs';
test('#9296 registry covers all 25 rows', () => assert.equal(PROBES.length, 25));
test('#9296 duplicate ids and capabilities cannot mask a failing probe', () => {
  const a = { id: 'ui.a', capability: 'a' };
  assert.throws(() => validateRegistry([a, { id: 'ui.a', capability: 'b' }]), /id/);
  assert.throws(() => validateRegistry([a, { id: 'ui.b', capability: 'a' }]), /capability/);
});
