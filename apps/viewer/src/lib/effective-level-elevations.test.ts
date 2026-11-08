/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9037 review: only an edit that can move a level gives it a live elevation. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveLevelElevations } from './effective-level-elevations.js';

describe('effectiveLevelElevations (#9013)', () => {
  it('a renamed level the parse never placed stays absent; a placed one keeps its parsed elevation', () => {
    const store = { spatialHierarchy: { storeyElevations: new Map([[10, 3]]) } } as unknown as IfcDataStore;
    const view = new MutablePropertyView(null, 'levels');
    view.setAttribute(10, 'Name', 'Ground');
    view.setAttribute(20, 'Name', 'Unplaced');
    assert.deepEqual([...effectiveLevelElevations(store, view, [10, 20])], [[10, 3]]);
  });
});
