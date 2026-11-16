/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { requireFixtures } from './fixture.js';

describe('CI fixture policy', () => {
  it('observes the fixture policy in Node tests, revert-oracle, and local runs', () => {
    const required = process.env.IFC_LITE_REQUIRE_FIXTURES === '1';
    if (process.env.GITHUB_JOB === 'node-tests') expect(required).toBe(true);
    if (process.env.GITHUB_JOB === 'revert-oracle') expect(required).toBe(false);
    expect(requireFixtures(process.env.IFC_LITE_REQUIRE_FIXTURES)).toBe(required);
  });
});
