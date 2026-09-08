/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `setProperty`'s optional `dataType` parameter (#3929/#3943) is the only
 * channel a caller — currently the viewer's IDS correction dialog — has to
 * tell a later reader what IFC measure dataType a value was scaled against
 * at write time. `@ifc-lite/ids/bridge`'s overlay resolver depends on it
 * reaching `getPropertyMutation()` unchanged, to scale a PROPERTY_MISSING
 * correction the same way it scales a correction to an existing property.
 * This pins that round-trip at the source; the bridge's own consumption of
 * it is covered separately in `packages/ids/src/bridge/override-unit-correction.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { PropertyValueType } from '@ifc-lite/data';

describe('MutablePropertyView.setProperty — dataType round-trip', () => {
  it('stores dataType on the PropertyMutation and returns it from getPropertyMutation', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(7, 'Pset_WallCommon', 'MaxHeight', 900, PropertyValueType.Real, undefined, false, 'IFCLENGTHMEASURE');

    const live = view.getPropertyMutation(7, 'Pset_WallCommon', 'MaxHeight');
    expect(live?.dataType).toBe('IFCLENGTHMEASURE');
    expect(live?.value).toBe(900);
  });

  it('leaves dataType undefined for a caller that never supplies one (every existing writer)', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const live = view.getPropertyMutation(7, 'Pset_WallCommon', 'FireRating');
    expect(live?.dataType).toBeUndefined();
  });
});
