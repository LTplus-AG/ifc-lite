/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistry } from './registry.mjs';
import { PROBES } from './index.mjs';
test('#9296 registry covers every catalogue row once', () => {
  const catalogue = JSON.parse(readFileSync(new URL('../../catalogue.json', import.meta.url), 'utf8'));
  assert.deepEqual(PROBES.map(p=>p.capability).sort(), catalogue.capabilities.filter(c=>c.tableStakes).map(c=>c.id).sort());
});
test('#9296 duplicate ids and capabilities cannot mask a failing probe', () => {
  const a = { id: 'ui.a', capability: 'a' };
  assert.throws(() => validateRegistry([a, { id: 'ui.a', capability: 'b' }]), /id/);
  assert.throws(() => validateRegistry([a, { id: 'ui.b', capability: 'a' }]), /capability/);
});
