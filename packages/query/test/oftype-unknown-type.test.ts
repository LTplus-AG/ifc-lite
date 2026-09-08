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
 *    correct, pre-existing behaviour. `ofType()` must NOT reject these.
 *
 * The discriminator therefore has to be an oracle that spans every schema the
 * parser reads, not one of them. An earlier revision keyed the check on
 * `IFC_ENTITY_NAMES` - IFC4X3-only, and hand-maintained - which rejected
 * `IfcDoorStyle` and `IfcWindowStyle`, the entities IFC2X3 files use to carry
 * door and window typing. The exhaustive sweeps below exist so that a
 * schema-coverage hole cannot pass again: a hand-picked sample of five names
 * that all happen to sit in one table cannot see it.
 *
 * See `ifc-query.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4,
  ENTITIES_IFC4X3,
  IFC_DATA_TYPES,
  type IfcStoreBase,
} from '@ifc-lite/data';
import { SCHEMA_REGISTRY, isKnownType, type IfcDataStore } from '@ifc-lite/parser';
import { createMockStore } from './mock-store.js';
import { IfcQuery } from '../src/ifc-query.js';

/** The one error `ofType()`'s guard raises. Nothing else may be mistaken for it. */
const GUARD_MESSAGE = /is not an entity name in any IFC schema/;

/**
 * `createMockStore` builds an `IfcStoreBase`. `IfcQuery` takes the parser's
 * `IfcDataStore`, which adds parse-time-only members (`source`, `parseTime`,
 * the deferred indices) that none of the code under test here reads. One
 * widening, named and explained, instead of an unchecked cast at every
 * construction site - so the mock's own shape stays type-checked against
 * `IfcStoreBase`.
 */
function queryFor(store: IfcStoreBase): IfcQuery {
  return new IfcQuery(store as unknown as IfcDataStore);
}

/**
 * The names `ofType()`'s guard rejected, out of `names`.
 *
 * Any error that is NOT the guard's is rethrown. A bare `catch { return true }`
 * cannot tell a wrong-name rejection from an unrelated crash - in the mock
 * store, the schema tables, or the oracle - so a sweep built on one reports
 * "nothing rejected" for a run in which the guard was never actually reached,
 * and passes for a reason it never verified.
 */
function namesRejectedByGuard(q: IfcQuery, names: readonly string[]): string[] {
  const rejected: string[] = [];
  for (const name of names) {
    try {
      q.ofType(name);
    } catch (e) {
      if (!(e instanceof Error) || !GUARD_MESSAGE.test(e.message)) throw e;
      rejected.push(name);
    }
  }
  return rejected;
}

/**
 * Standard buildingSMART entity names that `TYPE_STRING_TO_ENUM` has no entry
 * for. Each maps to `IfcTypeEnum.Unknown`, so a rule keyed on "did this map to
 * Unknown?" alone would wrongly reject every one of them. The last two are the
 * IFC2X3 door/window typing entities that the `IFC_ENTITY_NAMES` oracle
 * rejected.
 */
const STANDARD_BUT_UNMAPPED = [
  'IfcChiller',
  'IfcActuator',
  'IfcElectricAppliance',
  'IfcBuildingSystem',
  'IfcAudioVisualAppliance',
  'IfcDoorStyle',
  'IfcWindowStyle',
  // IFC2X3 flow-controller leaf, carried by `ENTITIES_IFC2X3` and by no enum.
  // Spelled `IfcElectricalDistributionPoint` here until #3172 -- a name with an
  // "AL" that IFC2X3 does not have, which reached this list from a misspelt arm
  // in `rust/core/src/legacy_entities.rs` by way of an alias row mirroring it.
  'IfcElectricDistributionPoint',
] as const;

/**
 * Names that are not IFC entity names in ANY schema this build reads, so
 * `ofType()` must keep rejecting them. Without this direction a guard that
 * accepted everything would pass the exhaustive sweeps below while having
 * removed the feature entirely.
 */
const NOT_IFC_ENTITY_NAMES = [
  'IfcWal', // the typo this guard exists for
  'IfcWalll',
  'IFCPROPRIETARYVENDORTHING',
  'Wall',
  'IfcLengthMeasure', // a real IFC *defined type*, not an entity
  '',
  // `Object.prototype` member names. The oracle's pin fallback asked
  // `name in SCHEMA_REGISTRY.entities`, and `in` walks the prototype chain,
  // so each of these answered "known" and `ofType()` handed back the Unknown
  // bucket - the exact silent-wrong-answer this guard exists to stop, reached
  // by a name the caller can produce from any untrusted string. Fixed in
  // `isKnownEntity`/`getEntityMetadata` (the codegen template) with
  // `Object.hasOwn` (#3063/#3069, not this branch - the fix belongs in the
  // template that emits the registry), so this list samples the class rather
  // than enumerating a denylist that would drift. These entries therefore only
  // pass once #3069 has landed.
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'isPrototypeOf',
  // The control: a plain non-IFC name, rejected before and after.
  'NotAThing',
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
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    // Caller made a typo: 'IfcWal' instead of 'IfcWall'.
    expect(() => query.ofType('IfcWal')).toThrow(/is not an entity name in any IFC schema/);
  });

  it('throws on a name that is not in the IFC schema at all', () => {
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    expect(() => query.ofType('IFCPROPRIETARYVENDORTHING')).toThrow(
      /is not an entity name in any IFC schema/,
    );
  });

  it('rejects a bad name even when a good one is passed alongside it', () => {
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    expect(() => query.ofType('IfcWall', 'IfcWal')).toThrow(/is not an entity name in any IFC schema/);
  });

  it('still allows an explicit query for the Unknown bucket itself', async () => {
    const query = queryFor(storeWithUnclassified('IFCPROPRIETARYVENDORTHING'));
    const ids = await query.ofType('Unknown').ids();
    expect(ids).toEqual([20]);
  });
});

/**
 * The guard trims; the resolution must trim too.
 *
 * `IfcTypeEnumFromString` only uppercases, so a padded `' IfcWall '` misses
 * `TYPE_STRING_TO_ENUM` and comes back `Unknown`. The guard then trims, finds
 * `IfcWall` known, and does NOT throw - so the query runs against the Unknown
 * bucket and answers with entities that are not walls, silently. Two
 * normalisations that disagree is the whole defect; the name must be a name the
 * enum table DOES map, or both paths yield Unknown for their own reasons and
 * the test cannot see it. `' IfcDoorStyle '` is exactly that useless fixture -
 * it is Unknown on both paths either way.
 */
describe('ofType() resolves a padded name through the same normalisation the guard uses', () => {
  it('a padded mapped name matches its own type, not the Unknown bucket', async () => {
    // Entity 10 is the IfcWall; entity 20 is the unclassified IfcChiller that
    // the Unknown bucket holds. Answering [20] means the padding turned a wall
    // query into an Unknown-bucket query.
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    expect(await query.ofType(' IfcWall ').ids()).toEqual([10]);
  });

  it('the unpadded name is unchanged by the trim', async () => {
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    expect(await query.ofType('IfcWall').ids()).toEqual([10]);
  });

  it('padding does not smuggle a genuine typo past the guard', () => {
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    expect(() => query.ofType('  IfcWal  ')).toThrow(GUARD_MESSAGE);
    // The message quotes the string the caller actually passed.
    expect(() => query.ofType('  IfcWal  ')).toThrow(/"  IfcWal  "/);
  });

  it('a padded name the enum table does not map still reaches the Unknown bucket', async () => {
    // The other direction of the same normalisation: trimming must not start
    // rejecting - or re-classifying - the standard-but-unmapped names.
    const query = queryFor(storeWithUnclassified('IFCCHILLER'));
    expect(await query.ofType(' IfcChiller ').ids()).toEqual([20]);
  });
});

describe('ofType() accepts standard IFC types the enum table does not map', () => {
  for (const typeName of STANDARD_BUT_UNMAPPED) {
    it(`${typeName} does not throw and still reaches the Unknown bucket`, async () => {
      const query = queryFor(storeWithUnclassified(typeName));
      expect(() => query.ofType(typeName)).not.toThrow();
      // The store's only unclassified entity is the one of this very type, so
      // the Unknown bucket answers the query correctly - as it did before the
      // guard existed. Entity 10 (a mapped IfcWall) must not leak in.
      const ids = await query.ofType(typeName).ids();
      expect(ids).toEqual([20]);
    });
  }

  it('accepts a standard unmapped type in any casing, with surrounding space', () => {
    const query = queryFor(storeWithUnclassified('IfcChiller'));
    expect(() => query.ofType('IFCCHILLER')).not.toThrow();
    expect(() => query.ofType('  ifcchiller  ')).not.toThrow();
  });
});

/**
 * The exhaustive sweeps. Every entity name in a schema table this build ships
 * must survive `ofType()`; a single rejection is a name a real file can carry
 * and a correctly spelled query cannot reach.
 */
describe('ofType() accepts every entity name in every schema this build reads', () => {
  const query = () => queryFor(storeWithUnclassified('IFCCHILLER'));

  /**
   * The upstream SchemaInfo tables carry EXPRESS *defined types*
   * (`IfcLengthMeasure`, `IfcBoolean`, `IfcArcIndex`, ...) as rows alongside
   * real ENTITY declarations, because IDS needs their names. They are not
   * entity names, so they are not part of what `ofType()` promises to accept -
   * subtract them rather than weakening the assertion to cover them.
   *
   * Two tables are needed to name them all, which is why this mirrors the
   * parser's own subtraction (`NON_ENTITY_NAMES_UPPER` in
   * `packages/parser/src/ifc-schema.ts`) instead of using `IFC_DATA_TYPES`
   * alone: the IDS table omits six that `SCHEMA_REGISTRY.types` carries
   * (`IfcBinary`, `IfcArcIndex`, `IfcLineIndex`, `IfcComplexNumber`,
   * `IfcCompoundPlaneAngleMeasure`, `IfcPropertySetDefinitionSet`).
   */
  const DEFINED_TYPES = new Set([
    ...IFC_DATA_TYPES.map((t) => t.name.toUpperCase()),
    ...Object.keys(SCHEMA_REGISTRY.types).map((n) => n.toUpperCase()),
    ...Object.keys(SCHEMA_REGISTRY.enums).map((n) => n.toUpperCase()),
    ...Object.keys(SCHEMA_REGISTRY.selects).map((n) => n.toUpperCase()),
  ]);

  const entityNames = (table: readonly { name: string }[]) =>
    table.map((e) => e.name).filter((n) => !DEFINED_TYPES.has(n.toUpperCase()));

  // The name the maintainer asked for by file: the parser's own registry,
  // `packages/parser/src/generated/schema-registry.ts`.
  it('accepts every entity in the parser SCHEMA_REGISTRY', () => {
    const q = query();
    const names = Object.keys(SCHEMA_REGISTRY.entities);
    expect(names.length).toBeGreaterThan(700);
    expect(namesRejectedByGuard(q, names)).toEqual([]);
  });

  for (const [schema, table] of [
    ['IFC2X3', ENTITIES_IFC2X3],
    ['IFC4', ENTITIES_IFC4],
    ['IFC4X3', ENTITIES_IFC4X3],
  ] as const) {
    it(`accepts every ${schema} entity name`, () => {
      const q = query();
      const names = entityNames(table);
      expect(names.length).toBeGreaterThan(400);
      expect(namesRejectedByGuard(q, names)).toEqual([]);
    });
  }
});

describe('ofType() still rejects names that are not IFC entity names', () => {
  it('the rejected names really are unknown to the parser, not just to ofType()', () => {
    // Pins the two directions to the SAME oracle: if a future change made
    // `isKnownType` accept these, the sweeps above would still pass while the
    // guard had quietly become a no-op. This fails first in that case.
    for (const bad of NOT_IFC_ENTITY_NAMES) {
      expect(isKnownType(bad)).toBe(false);
    }
  });

  for (const bad of NOT_IFC_ENTITY_NAMES) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const q = queryFor(storeWithUnclassified('IFCCHILLER'));
      expect(() => q.ofType(bad)).toThrow(/is not an entity name in any IFC schema/);
    });
  }

  it('names the offending string and points at Unknown, without blaming spelling alone', () => {
    const q = queryFor(storeWithUnclassified('IFCCHILLER'));
    let message = '';
    try {
      q.ofType('IfcWal');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"IfcWal"');
    expect(message).toContain('IFC2X3, IFC4, IFC4X3');
    expect(message).toContain("pass 'Unknown'");
  });
});
