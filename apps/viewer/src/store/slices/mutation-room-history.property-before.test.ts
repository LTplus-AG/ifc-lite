/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The types a room undo restores come from whichever same-named set holds the property (#10810). */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { propertyBefore } from './mutation-room-history.js';

it('reads a property that only the second of two same-named sets holds', () => {
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor(() => [
    { name: 'Pset_Test', globalId: 'a', properties: [{ name: 'Depth', type: PropertyValueType.String, value: 'x' }] },
    { name: 'Pset_Test', globalId: 'b', properties: [{ name: 'Width', type: PropertyValueType.Real, value: 0.2, dataType: 'IFCLENGTHMEASURE' }] },
  ]);
  assert.deepEqual(propertyBefore(view, 1, 'Pset_Test', 'Width'), { type: PropertyValueType.Real, dataType: 'IFCLENGTHMEASURE' });
});
