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
 * Reachable from outside the package, though not by the route I first claimed.
 * `serializeTypedMarker` is NOT in the package's index and `exports` maps only
 * ".", so no consumer can call it. The real route is the public data shape:
 * `IfcAttributeValue`'s `{ typed: { type, value } }` carries a caller-supplied
 * `type` string, and `MutablePropertyView.createEntity` and
 * `StoreEditor.setPositionalAttribute` both funnel it here through
 * `serializeStepValue`.
 *
 * The severity is higher that way, not lower: the throw escapes
 * `StepExporter.export()`, so one bad marker name aborts the ENTIRE file
 * export rather than one attribute.
 *
 * Sibling of the SCHEMA_REGISTRY.entities defect in #3063, which is still open
 * at the time of writing.
 */
describe('resolveExpressBase rejects inherited Object.prototype names', () => {
  // Derived, not hand-listed. A hand-picked sample is a guess about which
  // inherited names matter, and the interesting one (`__proto__`, which
  // resolves to an object rather than a function) is exactly the kind a sample
  // drops. This is exhaustive by construction and stays exhaustive if the
  // runtime grows a new Object.prototype member.
  const inherited = Object.getOwnPropertyNames(Object.prototype);

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
