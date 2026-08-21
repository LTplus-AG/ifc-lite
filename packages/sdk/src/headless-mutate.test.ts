/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createHeadlessMutateAdapter, propertyValueTypeOf } from './headless-mutate.js';

describe('propertyValueTypeOf', () => {
  it('classifies each JavaScript value the backend interface allows', () => {
    expect(propertyValueTypeOf('EI 60')).toBe(PropertyValueType.String);
    expect(propertyValueTypeOf(true)).toBe(PropertyValueType.Boolean);
    expect(propertyValueTypeOf(false)).toBe(PropertyValueType.Boolean);
    expect(propertyValueTypeOf(3)).toBe(PropertyValueType.Integer);
    expect(propertyValueTypeOf(-7)).toBe(PropertyValueType.Integer);
    expect(propertyValueTypeOf(1.5)).toBe(PropertyValueType.Real);
  });

  it('classifies a whole-number float as Integer, matching STEP', () => {
    // 3.0 is indistinguishable from 3 in JavaScript, so Integer is the only
    // answer available; IFCINTEGER(3) round-trips where IFCREAL would not.
    expect(propertyValueTypeOf(3.0)).toBe(PropertyValueType.Integer);
  });
});

describe('createHeadlessMutateAdapter', () => {
  const fakeView = () => ({
    setProperty: vi.fn(),
    setAttribute: vi.fn(),
    deleteProperty: vi.fn(),
  });

  it('forwards each call to the view with the expressId and a classified type', () => {
    const view = fakeView();
    const mutate = createHeadlessMutateAdapter(() => view as unknown as MutablePropertyView);
    const ref = { modelId: 'default', expressId: 42 };

    mutate.setProperty(ref, 'Pset_FireRating', 'FireCompartmentation', true);
    mutate.setAttribute(ref, 'Name', 'Renamed');
    mutate.deleteProperty(ref, 'Pset_WallCommon', 'Reference');

    expect(view.setProperty).toHaveBeenCalledWith(
      42, 'Pset_FireRating', 'FireCompartmentation', true, PropertyValueType.Boolean,
    );
    expect(view.setAttribute).toHaveBeenCalledWith(42, 'Name', 'Renamed');
    expect(view.deleteProperty).toHaveBeenCalledWith(42, 'Pset_WallCommon', 'Reference');
  });

  it('does not build the view until something is written', () => {
    const getView = vi.fn(() => fakeView() as unknown as MutablePropertyView);
    const mutate = createHeadlessMutateAdapter(getView);

    mutate.batchBegin('label');
    mutate.batchEnd('label');
    expect(mutate.undo('default')).toBe(false);
    expect(mutate.redo('default')).toBe(false);
    expect(getView).not.toHaveBeenCalled();

    mutate.setAttribute({ modelId: 'default', expressId: 1 }, 'Name', 'x');
    expect(getView).toHaveBeenCalledTimes(1);
  });
});
