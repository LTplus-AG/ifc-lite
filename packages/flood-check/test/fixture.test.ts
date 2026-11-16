/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fetched fixtures never skip silently: required in CI, a warning with the fetch command elsewhere (item 22). */

import { describe, expect, it } from 'vitest';
import { fixture, requireFixtures } from './fixture.js';

describe('the fixture policy', () => {
  it('only "1" requires fixtures; unset, "" and "0" allow a skip; anything else is refused', () => {
    for (const v of [undefined, '', '0']) expect(requireFixtures(v)).toBe(false);
    expect(requireFixtures('1')).toBe(true);
    expect(() => requireFixtures('yes')).toThrow(/not recognised/);
  });
  it('an absent fixture fails when required, naming the command that fetches it', () => {
    expect(() => fixture('georeferencer/does-not-exist.ifc', '1')).toThrow(/fetch-fixtures\.mjs georeferencer\/does-not-exist\.ifc/);
  });
  it('an absent fixture is reported, not silently skipped, when not required', () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      // '0' explicitly: an `undefined` argument would fall back to the environment, which CI sets to '1'.
      expect(fixture('georeferencer/does-not-exist.ifc', '0').present).toBe(false);
    } finally {
      console.warn = warn;
    }
    expect(warnings.join()).toMatch(/SKIPPING.*fetch-fixtures\.mjs georeferencer\/does-not-exist\.ifc/s);
  });
});
