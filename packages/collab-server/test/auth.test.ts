/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { canWrite, type Role } from '../src/auth.js';

describe('canWrite', () => {
  // Pins the exact role → write-capability mapping. Only `editor` and
  // `admin` may mutate the doc; `viewer` was already exercised end-to-end
  // in audit-rate.test.ts, but `commenter` had no coverage at all — a
  // mutation adding `principal.role === 'commenter'` to the `canWrite`
  // disjunction survived the full suite (138/138 still green) before this
  // test existed, because no test ever asked whether a commenter can write.
  it.each<[Role, boolean]>([
    ['viewer', false],
    ['commenter', false],
    ['editor', true],
    ['admin', true],
  ])('role=%s → canWrite=%s', (role, expected) => {
    expect(canWrite({ userId: 'u', role })).toBe(expected);
  });
});
