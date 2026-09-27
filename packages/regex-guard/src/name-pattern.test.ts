/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

describe('shared name matcher (#5894)', () => {
  it('keeps exact names case-sensitive and guarded patterns reusable across rows', async () => {
    const api = await import('./index.js');
    expect(api).toHaveProperty('compileNameMatcher');
    const { compileNameMatcher, isNamePattern } = api;
    const exact = compileNameMatcher('Pset_WallCommon');
    expect(exact('Pset_WallCommon')).toBe(true);
    expect(exact('pset_wallcommon')).toBe(false);

    const pattern = compileNameMatcher('/^pset_wall/i');
    expect(isNamePattern('/^pset_wall/i')).toBe(true);
    expect(pattern('Pset_WallCommon')).toBe(true);
    expect(pattern('Pset_DoorCommon')).toBe(false);
    expect(pattern('Pset_WallStandard')).toBe(true);
    expect(compileNameMatcher('/^pset_wall/i')).toBe(pattern);
  });

  it('refuses unsafe nested quantifiers before matching untrusted model names', async () => {
    const api = await import('./index.js');
    expect(api).toHaveProperty('unsafeNamePatternReason');
    const { compileNameMatcher, unsafeNamePatternReason } = api;
    expect(unsafeNamePatternReason('(a+)+$')).toMatch(/catastrophic/);
    expect(() => compileNameMatcher('/(a+)+$/')).toThrow(/rejected name pattern/);
  });
});
