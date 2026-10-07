/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotRegistry } from '@ifc-lite/extensions';
import { unavailablePlacements } from './slot-placements';

test('#6927 registry Flow contributions report their missing renderer', () => {
  const registry = new SlotRegistry();
  registry.register('fixture-extension', [{ extensionId: 'fixture-extension', slot: 'flowLibrary', payload: { title: 'Fixture flow' } }]);
  assert.deepEqual(unavailablePlacements(registry), [{ extensionId: 'fixture-extension', slot: 'flowLibrary', label: 'Fixture flow', reason: 'not-rendered' }]);
});
