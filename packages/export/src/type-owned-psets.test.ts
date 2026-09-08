/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `type-owned-psets.ts` had no test file of its own. Its main pass is well
 * covered indirectly by `overlay-effective-model.test.ts`, but two edges were
 * not: emitting `()` instead of `$` for an EMPTY `HasPropertySets` list, and
 * treating an UNKNOWN class (`typeOf` returned `undefined`) as a type object.
 * A mutation sweep left the suite green on both.
 *
 * `HasPropertySets` is `OPTIONAL SET [1:?]`, so `()` is schema-invalid — a
 * strict validator rejects the file. And a class no bundled schema declares
 * has no confirmed slot 5, so guessing "type object" writes a pset list into
 * whatever attribute happens to sit there.
 */

import { describe, it, expect } from 'vitest';
import { isTypeClass, hasPropertySetsToken, resolveTypeOwnedPsetIds, HAS_PROPERTY_SETS_SLOT } from './type-owned-psets.js';

describe('hasPropertySetsToken', () => {
  it('emits $ for an empty list, never an empty aggregate', () => {
    // HasPropertySets is OPTIONAL SET [1:?] — `()` violates the lower bound.
    expect(hasPropertySetsToken([])).toBe('$');
  });

  it('emits a reference aggregate in the given order', () => {
    expect(hasPropertySetsToken([7])).toBe('(#7)');
    expect(hasPropertySetsToken([7, 3, 11])).toBe('(#7,#3,#11)');
  });
});

describe('isTypeClass', () => {
  it('recognises a type object from its inheritance chain', () => {
    expect(isTypeClass('IFCWALLTYPE')).toBe(true);
  });

  it('recognises an IFC2X3 style class that does not end in Type', () => {
    expect(isTypeClass('IFCDOORSTYLE')).toBe(true);
    expect(isTypeClass('IFCWINDOWSTYLE')).toBe(true);
  });

  it('does not call an occurrence or a relationship a type object', () => {
    expect(isTypeClass('IFCWALL')).toBe(false);
    // Ends in TYPE but is a relationship — the suffix test's other failure.
    expect(isTypeClass('IFCRELDEFINESBYTYPE')).toBe(false);
  });

  it('treats an UNKNOWN class as an occurrence, the safe direction', () => {
    expect(isTypeClass('IFCNOTAREALCLASS')).toBe(false);
  });

  it('treats an ABSENT class as an occurrence rather than guessing', () => {
    // `effective.typeOf(id)` returns undefined for a record the exporter
    // cannot resolve; slot 5 of an unconfirmed class must not be written.
    expect(isTypeClass(undefined)).toBe(false);
  });

  it('pins the HasPropertySets slot index the routing writes into', () => {
    expect(HAS_PROPERTY_SETS_SLOT).toBe(5);
  });
});

describe('resolveTypeOwnedPsetIds', () => {
  const nameOf = (map: Record<number, string>) => (id: number) => map[id] ?? null;

  it('swaps an affected pset for its replacement in place', () => {
    const out = resolveTypeOwnedPsetIds(
      [10, 11],
      new Set(['Pset_A']),
      new Map([['Pset_A', 99]]),
      nameOf({ 10: 'Pset_A', 11: 'Pset_B' }),
    );
    expect(out).toEqual([99, 11]);
  });

  it('drops an affected pset that has no replacement (a deletion)', () => {
    const out = resolveTypeOwnedPsetIds(
      [10, 11],
      new Set(['Pset_A']),
      new Map(),
      nameOf({ 10: 'Pset_A', 11: 'Pset_B' }),
    );
    expect(out).toEqual([11]);
  });

  it('appends a replacement the original list never named', () => {
    const out = resolveTypeOwnedPsetIds(
      [11],
      new Set(['Pset_New']),
      new Map([['Pset_New', 99]]),
      nameOf({ 11: 'Pset_B' }),
    );
    expect(out).toEqual([11, 99]);
  });

  it('appends without duplicating one that was already swapped in', () => {
    // Both passes see Pset_A; only the first may emit it.
    const out = resolveTypeOwnedPsetIds(
      [10],
      new Set(['Pset_A']),
      new Map([['Pset_A', 99], ['Pset_New', 100]]),
      nameOf({ 10: 'Pset_A' }),
    );
    expect(out).toEqual([99, 100]);
  });

  it('carries an unreadable pset id through untouched', () => {
    // nameOf returns null for an overlay-created pset — never "affected".
    const out = resolveTypeOwnedPsetIds([10], new Set(['Pset_A']), new Map([['Pset_A', 99]]), () => null);
    expect(out).toEqual([10, 99]);
  });

  it('is the identity on an empty original list with no replacements', () => {
    expect(resolveTypeOwnedPsetIds([], new Set(), new Map(), () => null)).toEqual([]);
  });
});
