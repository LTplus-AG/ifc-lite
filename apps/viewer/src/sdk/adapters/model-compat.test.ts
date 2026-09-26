/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureDataStore } from '../../test/store-fixture.js';
import { getAllModelEntries } from './model-compat.js';

test('#5249 legacy SDK model omits parsed count as an entity ID bound', () => {
  const dataStore = fixtureDataStore([
    { expressId: 10, type: 'IfcWall' },
    { expressId: 30, type: 'IfcDoor' },
  ]);
  const entries = getAllModelEntries({ models: new Map(), ifcDataStore: dataStore });

  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].ifcDataStore, dataStore);
  assert.equal(Object.hasOwn(entries[0][1], 'maxExpressId'), false);
});
