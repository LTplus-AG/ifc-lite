/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotRegistry } from '@ifc-lite/extensions';
import { unavailablePlacements } from './slot-placements';

test('#7054 registry-backed flowLibrary contributions report their missing renderer', () => {
  const registry = new SlotRegistry();
  registry.register('example.extension', [
    { extensionId: 'example.extension', slot: 'flowLibrary', payload: { title: 'Review walls' } },
    { extensionId: 'example.extension', slot: 'toolbar.right', payload: { command: 'example.run' } },
  ]);
  assert.deepEqual(unavailablePlacements(registry), [{ extensionId: 'example.extension', slot: 'flowLibrary',
    label: 'Review walls', reason: 'not-rendered' }]);
});
