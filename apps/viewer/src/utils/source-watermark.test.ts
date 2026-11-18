/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { sourceWatermark } from './source-watermark.js';

it('an indexless table store still owns its table-only rows (#10139)', () => {
  const tabular = { entityIndex: {}, entities: { expressId: new Uint32Array([3, 900, 12]) } } as unknown as IfcDataStore;
  assert.equal(sourceWatermark(tabular), 900);
  assert.equal(sourceWatermark({ entityIndex: {} } as unknown as IfcDataStore), 0, 'a test double owns none');
  assert.equal(sourceWatermark(null), 0);
});
