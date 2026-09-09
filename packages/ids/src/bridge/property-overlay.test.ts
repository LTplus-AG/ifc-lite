/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';

import { createDataAccessor, type PropertyOverride } from './data-accessor.js';

/**
 * A wall (#1) with `Pset_WallCommon.FireRating = "NONE"` and one other
 * untouched property (`IsExternal = true`), plus a wall (#2) with no
 * properties at all — used to exercise the "missing property" overlay path.
 */
function makeStore(): IfcDataStore {
  const props = new Map<number, Array<{ name: string; properties: Array<{ name: string; value: unknown; type: number; dataType?: string }> }>>([
    [
      1,
      [
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'FireRating', value: 'NONE', type: 0, dataType: 'IFCLABEL' },
            { name: 'IsExternal', value: true, type: 3, dataType: 'IFCBOOLEAN' },
          ],
        },
      ],
    ],
    [2, []],
    // A wall whose base property name is cased differently than a spec's
    // exact `FireRating` (real-world non-conformant IFC export). getPropertyValue/
    // getPropertySets already tolerate this via a case-insensitive scan (#3943
    // review) — the overlay merge must too, or a correction can be written and
    // read back as `applied: true` yet remain permanently invisible to a
    // case-insensitive re-validation of the SAME accessor.
    [
      3,
      [
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'FIRERATING', value: 'N/A', type: 0, dataType: 'IFCLABEL' },
          ],
        },
      ],
    ],
    // A wall carrying TWO distinct `Pset_WallCommon` sets (e.g. one from
    // `IfcRelDefinesByProperties` on the type, one on the occurrence — a
    // legitimate model shape `collectAllPropertySets`/`property-overlay-resolver.ts`
    // both document). The first carries only `IsExternal`; the SECOND
    // carries `FireRating`. A first-match-only lookup against this shape
    // finds a `Pset_WallCommon` (the first one) but not the property this
    // override targets, so it takes the "create" branch against the WRONG
    // set instead of updating the real one.
    [
      4,
      [
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'IsExternal', value: true, type: 3, dataType: 'IFCBOOLEAN' },
          ],
        },
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'FireRating', value: 'NONE', type: 0, dataType: 'IFCLABEL' },
          ],
        },
      ],
    ],
  ]);

  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(),
    entities: {
      getTypeName: () => 'IfcWall',
      getObjectType: () => undefined,
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    entityIndex: { byId: new Map(), byType: new Map() },
    properties: {
      getForEntity: (id: number) => props.get(id) ?? [],
    },
    quantities: {
      getForEntity: () => [],
    },
  } as unknown as IfcDataStore;
}

describe('createDataAccessor property overlay (#3929)', () => {
  it('with no overlay, reads pass through to the canonical projection unchanged', () => {
    const accessor = createDataAccessor(makeStore());
    const value = accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating');
    expect(value?.value).toBe('NONE');
  });

  it('overlay patches only the named property, leaving siblings untouched', () => {
    const overrides = new Map<number, PropertyOverride[]>([
      [1, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

    expect(accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value).toBe('F90');
    // The sibling property is untouched by the overlay.
    expect(accessor.getPropertyValue(1, 'Pset_WallCommon', 'IsExternal')?.value).toBe(true);
  });

  it('overlay can add a property to an entity that had none (PROPERTY_MISSING correction)', () => {
    const overrides = new Map<number, PropertyOverride[]>([
      [2, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

    expect(accessor.getPropertyValue(2, 'Pset_WallCommon', 'FireRating')?.value).toBe('F90');
  });

  it('overlay can delete a property (used to undo a bad in-session correction)', () => {
    const overrides = new Map<number, PropertyOverride[]>([
      [1, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: null, deleted: true }]],
    ]);
    const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

    expect(accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBeUndefined();
    expect(accessor.getPropertySets(1)[0].properties).toHaveLength(1);
  });

  it('an entity with no overrides is unaffected even when other entities have some', () => {
    const overrides = new Map<number, PropertyOverride[]>([
      [2, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

    expect(accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value).toBe('NONE');
  });

  it('the resolver returning undefined (mutation-view-not-registered-for-model) behaves as no overlay', () => {
    const accessor = createDataAccessor(makeStore(), () => undefined);
    expect(accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value).toBe('NONE');
  });

  it('a correction targeting the spec-exact name overwrites a base property stored under a different casing, not a shadowed duplicate (#3943)', () => {
    const overrides = new Map<number, PropertyOverride[]>([
      [3, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

    // getPropertyValue is case-insensitive (matches the pre-existing bridge
    // contract) — it must see the CORRECTED value, not the stale base one.
    expect(accessor.getPropertyValue(3, 'Pset_WallCommon', 'FireRating')?.value).toBe('F90');
    expect(accessor.getPropertyValue(3, 'Pset_WallCommon', 'FIRERATING')?.value).toBe('F90');

    // Exactly one property under Pset_WallCommon — the override must UPDATE
    // the existing (differently-cased) entry, not sit alongside it as a
    // second, differently-cased property that a case-insensitive scan could
    // resolve to either one depending on array order.
    expect(accessor.getPropertySets(3)[0].properties).toHaveLength(1);
  });

  describe('same-named-pset collision (two distinct Pset_WallCommon sets, #4XXX)', () => {
    it('an update corrects the value on the SET THAT ACTUALLY CARRIES the property, not the first same-named set', () => {
      const overrides = new Map<number, PropertyOverride[]>([
        [4, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
      ]);
      const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

      expect(accessor.getPropertyValue(4, 'Pset_WallCommon', 'FireRating')?.value).toBe('F90');

      // No duplicate FireRating was created: exactly one property named
      // FireRating exists across BOTH same-named psets combined.
      const sets = accessor.getPropertySets(4).filter((p) => p.name === 'Pset_WallCommon');
      const fireRatingCount = sets
        .flatMap((s) => s.properties)
        .filter((p) => p.name === 'FireRating').length;
      expect(fireRatingCount).toBe(1);

      // The sibling property on the OTHER same-named set is untouched.
      expect(accessor.getPropertyValue(4, 'Pset_WallCommon', 'IsExternal')?.value).toBe(true);
    });

    it('a delete removes the property from the set that actually carries it, and the read-back confirms it is gone', () => {
      const overrides = new Map<number, PropertyOverride[]>([
        [4, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: null, deleted: true }]],
      ]);
      const accessor = createDataAccessor(makeStore(), (id) => overrides.get(id));

      expect(accessor.getPropertyValue(4, 'Pset_WallCommon', 'FireRating')).toBeUndefined();

      const sets = accessor.getPropertySets(4).filter((p) => p.name === 'Pset_WallCommon');
      const fireRatingCount = sets
        .flatMap((s) => s.properties)
        .filter((p) => p.name === 'FireRating').length;
      expect(fireRatingCount).toBe(0);

      // The other set's own property survives.
      expect(accessor.getPropertyValue(4, 'Pset_WallCommon', 'IsExternal')?.value).toBe(true);
    });
  });
});
