/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { resolveExpressBase } from './step-serialization.js';

/**
 * `SCHEMA_REGISTRY.types` is a plain object literal, so `types[cursor]` reaches
 * Object.prototype.
 *
 * `resolveExpressBase` documents "Returns null for a type the registry doesn't
 * know". For an inherited name it did not return null and it did not return a
 * wrong answer either: the lookup produced the `Object` constructor, which is
 * truthy, so the `!underlying` guard let it through and the next line called
 * `.replace()` on a function.
 *
 *   TypeError: underlying.replace is not a function
 *
 * That is reachable from outside the package. `serializeTypedMarker(type, ...)`
 * takes the marker name from the caller, so authoring code that passes a
 * `{ typed: 'constructor' }` marker gets a crash rather than the documented
 * null. Sibling of #3063, which fixed `SCHEMA_REGISTRY.entities`.
 */
describe('resolveExpressBase rejects inherited Object.prototype names', () => {
  const inherited = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'];

  it.each(inherited)('returns null for %s rather than throwing', (name) => {
    // Both halves matter. `not.toThrow` alone would pass if the function
    // returned the Object constructor stringified, and `toBe(null)` alone
    // reports a TypeError as a test error rather than as the defect it is.
    expect(() => resolveExpressBase(name)).not.toThrow();
    expect(resolveExpressBase(name)).toBeNull();
  });

  // Without these, returning null unconditionally passes the block above and
  // would silently disable every defined-type resolution in STEP export.
  it('still resolves a direct defined type to its EXPRESS primitive', () => {
    expect(resolveExpressBase('IfcBoolean')).toBe('BOOLEAN');
  });

  it('still walks a nested alias chain', () => {
    // IfcPositiveLengthMeasure -> IfcLengthMeasure -> REAL
    expect(resolveExpressBase('IfcPositiveLengthMeasure')).toBe('REAL');
  });

  it('still returns null for a name that is simply unknown', () => {
    expect(resolveExpressBase('NotARealDefinedType')).toBeNull();
  });
});
