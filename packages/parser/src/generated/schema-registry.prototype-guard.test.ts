/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isKnownEntity` is the authoring guard: callers use it to decide whether a
 * type name a user typed is a real IFC entity. It looked up the registry with
 * `in`, which walks the prototype chain, so it answered TRUE for every
 * `Object.prototype` member.
 *
 * That is not cosmetic. `normalizeIfcTypeName('constructor')` returns
 * `"Object"`, so a guard that accepts `constructor` hands the next stage a
 * type name that is not an entity at all (issue #3063).
 *
 * The registry is generated, so the real fix is in
 * `packages/codegen/src/typescript-generator.ts`. This test lives here because
 * this is the copy the parser actually ships and imports.
 */
import { describe, it, expect } from 'vitest';
import { isKnownEntity } from './schema-registry.js';

describe('isKnownEntity — prototype chain (#3063)', () => {
  // Every member `in` would have found on Object.prototype.
  const inherited = [
    'constructor',
    'toString',
    'toLocaleString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ];

  for (const name of inherited) {
    it(`rejects the inherited property "${name}"`, () => {
      expect(isKnownEntity(name)).toBe(false);
    });
  }

  // The other direction, so "always false" is not a passing fix.
  it('still accepts real entities, in both the PascalCase and STEP spellings', () => {
    expect(isKnownEntity('IfcWall')).toBe(true);
    expect(isKnownEntity('IFCWALL')).toBe(true);
    expect(isKnownEntity('IfcDoor')).toBe(true);
  });

  it('still rejects a plainly unknown name', () => {
    expect(isKnownEntity('NotARealType')).toBe(false);
  });
});
