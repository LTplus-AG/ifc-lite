// SPDX-License-Identifier: MPL-2.0
/**
 * An empty MapUnit label must bind to nothing.
 *
 * `resolveMapUnitReference`'s caller in `step-georeferencing.ts` guards
 * `crs.mapUnit !== undefined`, not `!== ''`, and `normalizeMapUnitName('')`
 * returns `''`. Both comparisons inside `findLengthUnitReference` fold a
 * non-string Name attribute to `''` as well, so an empty label used to match
 * whichever unit in the file happened to have a malformed name. The unit it
 * picked was an artefact of file order, not of anything the caller asked for.
 */

import { describe, it, expect } from 'vitest';
import { findLengthUnitReference } from './step-map-unit.js';

describe('an empty map-unit label matches nothing (#3274)', () => {
  it('returns null before it compares anything', () => {
    // The context is deliberately hostile: if the guard is removed, the scan
    // runs and every stub below is shaped to produce a `''` name.
    const ctx = {
      dataStore: {
        entityIndex: {
          byId: new Map([
            [1, {}],
            [2, {}],
            [3, {}],
          ]),
        },
      },
      entityExtractor: {
        extractEntity: (ref: unknown) => {
          if (ref === undefined) return null;
          // #1 project -> unit assignment #2 -> units [#3]
          const seen = extracted.shift();
          return seen ?? null;
        },
      },
    } as never;
    const extracted: unknown[] = [
      // UnitsInContext is attribute 8; a sparse array reads as a lint error
      // and, worse, as a typo. Build it explicitly.
      { type: 'IFCPROJECT', attributes: [...Array<unknown>(8).fill(null), 2] },
      { type: 'IFCUNITASSIGNMENT', attributes: [[3]] },
      // A conversion-based unit whose Name is not a string, so it folds to ''.
      { type: 'IFCCONVERSIONBASEDUNIT', attributes: [null, '.LENGTHUNIT.', 42] },
    ];
    const effective = {
      byType: new Map([['IFCPROJECT', [1]]]),
      isDeleted: () => false,
    } as never;

    expect(findLengthUnitReference('', effective, ctx)).toBeNull();
  });
});
