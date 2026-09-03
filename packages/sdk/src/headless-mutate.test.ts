/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createEffectiveEntityExists, createHeadlessMutateAdapter, propertyValueTypeOf } from './headless-mutate.js';

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
    const mutate = createHeadlessMutateAdapter(
      () => view as unknown as MutablePropertyView,
      ref => ref.modelId === 'default' && ref.expressId === 42,
    );
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
    const mutate = createHeadlessMutateAdapter(getView, () => true);

    mutate.batchBegin('label');
    mutate.batchEnd('label');
    expect(mutate.undo('default')).toBe(false);
    expect(mutate.redo('default')).toBe(false);
    expect(getView).not.toHaveBeenCalled();

    mutate.setAttribute({ modelId: 'default', expressId: 1 }, 'Name', 'x');
    expect(getView).toHaveBeenCalledTimes(1);
  });
  // #3760's sibling: a write to an entity that is not in the model used to be
  // accepted, echoed back by `bim.properties()`, and then silently dropped by
  // the exporter — the caller had no point in the round trip where the mistake
  // showed up.
  describe('refusing a write to an entity the model does not hold', () => {
    // Only `#42` of `'default'` exists. Both halves matter: the express id and
    // the model id are separate ways for a reference to be wrong, and the
    // adapter forwards neither on, so each has to be caught here.
    const adapterOverOneEntity = () => {
      const view = fakeView();
      const mutate = createHeadlessMutateAdapter(
        () => view as unknown as MutablePropertyView,
        ref => ref.modelId === 'default' && ref.expressId === 42,
      );
      return { view, mutate };
    };

    it('throws on setProperty, naming both the express id and the model id', () => {
      const { view, mutate } = adapterOverOneEntity();

      // Asserted on BOTH identifiers, not just the express id: the error has to
      // say which model it looked in, and a message that dropped the model id
      // would still match a bare /999999/.
      expect(() => mutate.setProperty(
        { modelId: 'default', expressId: 999999 }, 'Pset_Bogus', 'Foo', 'bar',
      )).toThrow(/#999999.*'default'/);
      expect(view.setProperty).not.toHaveBeenCalled();
    });

    it('throws on an express id that exists in ANOTHER model', () => {
      // The dangerous half of the reference. Every write method forwards
      // `ref.expressId` alone into this backend's single overlay, so an
      // unchecked model id does not miss — it writes #42 of the active model,
      // which is a wrong edit rather than a dropped one.
      const { view, mutate } = adapterOverOneEntity();

      expect(() => mutate.setProperty(
        { modelId: 'other', expressId: 42 }, 'Pset_Bogus', 'Foo', 'bar',
      )).toThrow(/#42.*'other'/);
      expect(view.setProperty).not.toHaveBeenCalled();
    });

    // The defect class, not the one instance of it: `setAttribute` and
    // `deleteProperty` reach the same overlay through the same unvalidated
    // express id and are dropped by the same exporter walk.
    it('throws on setAttribute and deleteProperty too', () => {
      const { view, mutate } = adapterOverOneEntity();
      const phantom = { modelId: 'default', expressId: 999999 };

      expect(() => mutate.setAttribute(phantom, 'Name', 'x'))
        .toThrow(/setAttribute: no entity #999999 in model 'default'/);
      expect(() => mutate.deleteProperty(phantom, 'Pset_WallCommon', 'Reference'))
        .toThrow(/deleteProperty: no entity #999999 in model 'default'/);
      expect(view.setAttribute).not.toHaveBeenCalled();
      expect(view.deleteProperty).not.toHaveBeenCalled();
    });

    it('accepts the entity that does exist', () => {
      // Guards the three assertions above: they have to fail on the reference,
      // not on every reference.
      const { view, mutate } = adapterOverOneEntity();
      const ref = { modelId: 'default', expressId: 42 };

      mutate.setProperty(ref, 'Pset_WallCommon', 'Reference', 'W-01');
      mutate.setAttribute(ref, 'Name', 'x');
      mutate.deleteProperty(ref, 'Pset_WallCommon', 'Reference');

      expect(view.setProperty).toHaveBeenCalledTimes(1);
      expect(view.setAttribute).toHaveBeenCalledTimes(1);
      expect(view.deleteProperty).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createEffectiveEntityExists', () => {
  // `MutablePropertyView`'s two overlay questions, faked. The real view keeps
  // created ids OUT of `store.entityIndex.byId` on purpose, so these are the
  // only place either answer can come from.
  const overlayWith = (created: number[], deleted: number[]) => ({
    getNewEntity: (id: number) => (created.includes(id) ? { expressId: id } : null),
    isDeleted: (id: number) => deleted.includes(id),
  }) as unknown as MutablePropertyView;

  const source = new Set([70, 71]);
  const build = (overlay: MutablePropertyView | null) => createEffectiveEntityExists({
    acceptsModelId: id => id === 'default' || id === 'model.ifc',
    hasSourceEntity: id => source.has(id),
    overlay: () => overlay,
  });

  it('accepts a source entity and refuses an id nothing holds', () => {
    const exists = build(null);
    expect(exists({ modelId: 'default', expressId: 70 })).toBe(true);
    expect(exists({ modelId: 'default', expressId: 999999 })).toBe(false);
  });

  it('accepts an overlay-created id the base index has never heard of', () => {
    // The create-then-decorate workflow. A predicate that asked
    // `entityIndex.byId` alone would reject the id the session just handed out.
    const exists = build(overlayWith([9001], []));
    expect(exists({ modelId: 'default', expressId: 9001 })).toBe(true);
  });

  it('refuses a tombstoned source id the base index still holds', () => {
    const exists = build(overlayWith([], [70]));
    expect(exists({ modelId: 'default', expressId: 70 })).toBe(false);
    expect(exists({ modelId: 'default', expressId: 71 })).toBe(true);
  });

  it('refuses every id under a model id the backend does not answer for', () => {
    const exists = build(overlayWith([9001], []));
    expect(exists({ modelId: 'other', expressId: 70 })).toBe(false);
    expect(exists({ modelId: 'other', expressId: 9001 })).toBe(false);
    // Both accepted spellings of the one model still pass.
    expect(exists({ modelId: 'model.ifc', expressId: 70 })).toBe(true);
  });

  it('never builds the overlay for a session that has not written', () => {
    const overlay = vi.fn(() => null);
    const exists = createEffectiveEntityExists({
      acceptsModelId: () => true,
      hasSourceEntity: () => true,
      overlay,
    });

    expect(exists({ modelId: 'default', expressId: 70 })).toBe(true);
    // The thunk is called, but it hands back the field as it stands — it is not
    // `getOrCreateMutationView`, so asking never creates one.
    expect(overlay).toHaveBeenCalledTimes(1);
  });
});
