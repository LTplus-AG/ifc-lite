/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A base property seen through the overlay keeps its `structure` (#5475):
 * rules read a list or table member by member, and the viewer's search
 * reads properties through this view as soon as one is registered, so
 * dropping the marker here would silently revert search to the joined
 * display string while validation (reading the store) matched members.
 */

import { describe, it, expect } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';

describe('MutablePropertyView keeps a base property\'s structure (#5475)', () => {
  it('passes structure and values through getForEntity', () => {
    const view = new MutablePropertyView(null, 'model');
    view.setOnDemandExtractor(() => [{
      name: 'Pset_Test',
      properties: [
        { name: 'Colors', type: 0, value: 'Red, Blue', values: ['Red', 'Blue'], structure: 'list' },
        { name: 'Plain', type: 0, value: 'x' },
      ],
    }]);
    const [set] = view.getForEntity(1);
    expect(set.properties[0]).toMatchObject({ structure: 'list', values: ['Red', 'Blue'] });
    expect(set.properties[1]).not.toHaveProperty('structure');
  });
});
