/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { isKnownType, isInstantiable, normalizeIfcTypeName } from './ifc-schema.js';
import { getTypeId } from './generated/type-ids.js';

/**
 * #3063. The generated SCHEMA_REGISTRY is a plain object literal, so `in` and
 * `obj[key]` both reach Object.prototype.
 *
 * This file pins the DAMAGE, not the mechanism. The mechanism is pinned in
 * packages/codegen/test/typescript-generator-mapping.test.ts, against the text
 * the generator emits, which is the only copy that cannot drift. What that
 * cannot see is which of this package's exported guards the defect reached,
 * and those are the ones callers actually hold:
 *
 *   isKnownType('constructor')           false   (was already false)
 *   isInstantiable('constructor')        TRUE    <- the authoring guard
 *   normalizeIfcTypeName('constructor')  "Object"
 *   normalizeIfcTypeName('__proto__')    undefined, from a `: string` signature
 *
 * isInstantiable is the one that matters. Its own docblock says it exists so
 * authoring code cannot write an abstract class into an exported file, and it
 * was the weaker of the two: it said yes to `constructor` while isKnownType,
 * the guard that reads as looser, correctly said no.
 */
describe('schema guards reject inherited Object.prototype names', () => {
  // `__proto__` is deliberately in this list and is not like the others: it
  // resolves to an object rather than a function, so its `.name` is undefined
  // rather than a string. It is the case that turned a wrong answer into a
  // type lie.
  const inherited = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

  it.each(inherited)('isInstantiable(%s) is false', (name) => {
    expect(isInstantiable(name)).toBe(false);
  });

  it.each(inherited)('isKnownType(%s) is false', (name) => {
    expect(isKnownType(name)).toBe(false);
  });

  it.each(inherited)('normalizeIfcTypeName(%s) returns the name unchanged', (name) => {
    // Unknown names are preserved as-is, because a vendor extension is not an
    // error. The failure being pinned is returning something ELSE: "Object"
    // for `constructor`, or undefined for `__proto__`.
    const result = normalizeIfcTypeName(name);
    expect(typeof result).toBe('string');
    expect(result).toBe(name);
  });

  // The same generator emits a second registry, and it had the same defect.
  // The comment added to typescript-generator.ts says every lookup below it
  // must be an own-property check, which was true of that file and read as
  // covering the generator, so this is the sibling that claim would have hidden.
  it.each(inherited)('getTypeId(%s) is undefined, not a function', (name) => {
    const id = getTypeId(name);
    // `number | undefined` is the declared return. Before the fix this handed
    // back the Object constructor for `constructor` and Object.prototype for
    // `__proto__`, so asserting `undefined` alone would pass for the wrong
    // reason if the signature were ever loosened. Assert the type too.
    expect(id).toBeUndefined();
    expect(typeof id).not.toBe('function');
  });

  it('still resolves a real type id', () => {
    expect(typeof getTypeId('IfcWall')).toBe('number');
  });

  // Without these the suite is satisfied by making every guard return false,
  // which would be a worse bug than the one being fixed.
  it('still answers for real entities', () => {
    expect(isKnownType('IfcWall')).toBe(true);
    expect(isInstantiable('IfcWall')).toBe(true);
    expect(normalizeIfcTypeName('IFCWALL')).toBe('IfcWall');
  });

  it('still reports an abstract class as known but not instantiable', () => {
    // The distinction isInstantiable exists to draw. If the fix had broken it,
    // the inherited-name cases above would still pass.
    expect(isKnownType('IfcRoot')).toBe(true);
    expect(isInstantiable('IfcRoot')).toBe(false);
  });
});
