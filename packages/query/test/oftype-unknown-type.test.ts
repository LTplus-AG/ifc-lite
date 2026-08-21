/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcQuery.ofType()` maps a type string through `IfcTypeEnumFromString`,
 * which falls back to `IfcTypeEnum.Unknown` for any name it does not
 * recognize. That single fallback covers two different situations, and only
 * one of them is a caller error:
 *
 *  - `'IfcWal'` is not an IFC entity name at all, so the caller meant
 *    `'IfcWall'`. Silently answering with the Unknown bucket - every entity
 *    the store could not classify - returns some other, unrelated set of
 *    entities. `ofType()` rejects this.
 *
 *  - `'IfcChiller'` IS a standard IFC4 entity name; `TYPE_STRING_TO_ENUM`
 *    (packages/data/src/types.ts) is a curated subset that has no row for it,
 *    so it maps to Unknown as well. The Unknown bucket is the only
 *    representation this build has for such an entity, and querying it is the
 *    correct, pre-existing behaviour. `ofType()` must NOT reject these - the
 *    discriminator is `IFC_ENTITY_NAMES`, not the enum table.
 *
 * See `ifc-query.ts`.
 */

import { describe, it, expect } from 'vitest';
import { createMockStore } from './mock-store.js';
import { IfcQuery } from '../src/ifc-query.js';

/**
 * Standard buildingSMART entity names that `TYPE_STRING_TO_ENUM` has no entry
 * for. Each maps to `IfcTypeEnum.Unknown`, so a rule keyed on "did this map to
 * Unknown?" alone would wrongly reject all five.
 */
const STANDARD_BUT_UNMAPPED = [
  'IfcChiller',
  'IfcActuator',
  'IfcElectricAppliance',
  'IfcBuildingSystem',
  'IfcAudioVisualAppliance',
] as const;

function storeWithUnclassified(unclassifiedType: string) {
  return createMockStore({
    entities: [
      { expressId: 10, type: 'IFCWALL', globalId: 'g10', name: 'Real Wall' },
      {
        expressId: 20,
        type: unclassifiedType.trim().toUpperCase(),
        globalId: 'g20',
        name: 'Unclassified',
      },
    ],
  });
}

describe('ofType() rejects a type string that is not an IFC entity name', () => {
  it('throws on a typo rather than silently matching the Unknown bucket', () => {
    const query = new IfcQuery(storeWithUnclassified('IFCCHILLER') as any);
    // Caller made a typo: 'IfcWal' instead of 'IfcWall'.
    expect(() => query.ofType('IfcWal')).toThrow(/is not an IFC entity name/);
  });

  it('throws on a name that is not in the IFC schema at all', () => {
    const query = new IfcQuery(storeWithUnclassified('IFCCHILLER') as any);
    expect(() => query.ofType('IFCPROPRIETARYVENDORTHING')).toThrow(
      /is not an IFC entity name/,
    );
  });

  it('rejects a bad name even when a good one is passed alongside it', () => {
    const query = new IfcQuery(storeWithUnclassified('IFCCHILLER') as any);
    expect(() => query.ofType('IfcWall', 'IfcWal')).toThrow(/is not an IFC entity name/);
  });

  it('still allows an explicit query for the Unknown bucket itself', async () => {
    const query = new IfcQuery(storeWithUnclassified('IFCPROPRIETARYVENDORTHING') as any);
    const ids = await query.ofType('Unknown').ids();
    expect(ids).toEqual([20]);
  });
});

describe('ofType() accepts standard IFC types the enum table does not map', () => {
  for (const typeName of STANDARD_BUT_UNMAPPED) {
    it(`${typeName} does not throw and still reaches the Unknown bucket`, async () => {
      const query = new IfcQuery(storeWithUnclassified(typeName) as any);
      expect(() => query.ofType(typeName)).not.toThrow();
      // The store's only unclassified entity is the one of this very type, so
      // the Unknown bucket answers the query correctly - as it did before the
      // guard existed. Entity 10 (a mapped IfcWall) must not leak in.
      const ids = await query.ofType(typeName).ids();
      expect(ids).toEqual([20]);
    });
  }

  it('accepts a standard unmapped type in any casing, with surrounding space', () => {
    const query = new IfcQuery(storeWithUnclassified('IfcChiller') as any);
    expect(() => query.ofType('IFCCHILLER')).not.toThrow();
    expect(() => query.ofType('  ifcchiller  ')).not.toThrow();
  });
});
