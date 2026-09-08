/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for the shared attribute coercions used by the material,
 * georef, and classification extractors.
 *
 * Only `getReference`'s `#`-prefixed form was reachable from an existing test.
 * The STEP logical sentinels (`.T.` / `.F.`) and the non-string coercion in
 * `getString` both survived mutation across the whole monorepo.
 */

import { describe, expect, it } from 'vitest';
import {
  getBoolean,
  getNumber,
  getReference,
  getReferences,
  getString,
  getStringList,
} from '../src/attribute-helpers.js';

describe('getString', () => {
  it('passes a string through unchanged', () => {
    expect(getString('wall')).toBe('wall');
    expect(getString('')).toBe('');
  });

  it('coerces a non-string scalar to its string form', () => {
    // IFC numeric/boolean attributes reach the extractors untyped; returning
    // undefined here would silently blank out a name or an identifier.
    expect(getString(42)).toBe('42');
    expect(getString(0)).toBe('0');
    expect(getString(true)).toBe('true');
  });

  it('returns undefined only for null and undefined', () => {
    expect(getString(null)).toBeUndefined();
    expect(getString(undefined)).toBeUndefined();
  });
});

describe('getNumber', () => {
  it('passes a number through, including zero', () => {
    expect(getNumber(1.5)).toBe(1.5);
    expect(getNumber(0)).toBe(0);
  });

  it('parses a numeric string', () => {
    expect(getNumber('2.5')).toBe(2.5);
    expect(getNumber('-3')).toBe(-3);
  });

  it('returns undefined for a non-numeric string and for non-scalars', () => {
    expect(getNumber('abc')).toBeUndefined();
    expect(getNumber(null)).toBeUndefined();
    expect(getNumber(undefined)).toBeUndefined();
    expect(getNumber(true)).toBeUndefined();
    expect(getNumber([1])).toBeUndefined();
  });
});

describe('getBoolean', () => {
  it('maps the STEP `.T.` logical to true', () => {
    expect(getBoolean('.T.')).toBe(true);
    expect(getBoolean('T')).toBe(true);
    expect(getBoolean('true')).toBe(true);
  });

  it('maps the STEP `.F.` logical to false', () => {
    // `.F.` must resolve to `false`, not to `undefined`. Callers treat
    // undefined as "not stated" and fall back to a default, so losing `.F.`
    // turns an explicit "no" into whatever the default happens to be.
    expect(getBoolean('.F.')).toBe(false);
    expect(getBoolean('F')).toBe(false);
    expect(getBoolean('false')).toBe(false);
  });

  it('passes a real boolean through', () => {
    expect(getBoolean(true)).toBe(true);
    expect(getBoolean(false)).toBe(false);
  });

  it('returns undefined for the unset/unknown third state', () => {
    // `$` (unset) and `.U.` (logical unknown) are neither true nor false.
    expect(getBoolean(null)).toBeUndefined();
    expect(getBoolean(undefined)).toBeUndefined();
    expect(getBoolean('.U.')).toBeUndefined();
    expect(getBoolean('$')).toBeUndefined();
  });
});

describe('getReference', () => {
  it('passes a numeric reference through', () => {
    expect(getReference(12)).toBe(12);
  });

  it('strips the `#` prefix from a string reference', () => {
    expect(getReference('#12')).toBe(12);
  });

  it('returns undefined for a string without the `#` marker', () => {
    expect(getReference('12')).toBeUndefined();
    expect(getReference('#')).toBeUndefined();
    expect(getReference('#abc')).toBeUndefined();
  });

  it('returns undefined for null, undefined and non-scalars', () => {
    expect(getReference(null)).toBeUndefined();
    expect(getReference(undefined)).toBeUndefined();
    expect(getReference({})).toBeUndefined();
  });
});

describe('getReferences', () => {
  it('collects the resolvable references and drops the rest', () => {
    expect(getReferences([1, '#2', null, 'nope', '#3'])).toEqual([1, 2, 3]);
  });

  it('returns undefined for a non-array (an absent aggregate, not an empty one)', () => {
    expect(getReferences('#1')).toBeUndefined();
    expect(getReferences(null)).toBeUndefined();
  });

  it('returns an empty array for an empty aggregate', () => {
    expect(getReferences([])).toEqual([]);
  });
});

describe('getStringList', () => {
  it('coerces every entry and drops only null/undefined', () => {
    expect(getStringList(['a', 1, null, undefined, 'b'])).toEqual(['a', '1', 'b']);
  });

  it('returns undefined for a non-array', () => {
    expect(getStringList('a')).toBeUndefined();
  });
});
