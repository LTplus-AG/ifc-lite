/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `migrateManifest` version-guard coverage.
 *
 * `manifest.test.ts` pins the "newer than we support" and the
 * "non-numeric" cases. It does not pin the integrality / positivity
 * half of the same guard: deleting `!Number.isInteger(rawVersion)` and
 * `rawVersion < 1` left the whole suite green, and a manifest declaring
 * `manifestVersion: 0` or `1.5` would then be waved through as
 * already-current.
 *
 * The code alone is NOT a discriminator here. `migrateManifest` emits
 * `invalid_manifest_version` at path `manifestVersion` from *three*
 * independent places: the shape guard, the "newer than supported"
 * branch, and the "no migration available" branch at the bottom of the
 * chain loop. So `0` still errors with deleting `rawVersion < 1` (it
 * falls through to "no migration available from v0"), and `1.5` still
 * errors with `!Number.isInteger` deleted (`1.5 > 1` hits the
 * newer-than-supported branch). Both mutations survive a code-only
 * assertion. Each case below therefore asserts the guard's own
 * *message*, which is what actually distinguishes the three rules.
 */

import { describe, expect, it } from 'vitest';
import { CURRENT_MANIFEST_VERSION, migrateManifest, migrateV1 } from './index.js';

/** The shape guard's own message — distinct from the other two rules'. */
const SHAPE_GUARD_MESSAGE = 'manifestVersion is required and must be a positive integer.';

function errorCodes(input: Record<string, unknown>): string[] {
  const r = migrateManifest(input);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

/** Assert the *shape guard* rejected it, not one of its two look-alikes. */
function expectShapeGuardRejection(v: unknown): void {
  const r = migrateManifest({ manifestVersion: v as number });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].path).toBe('manifestVersion');
  expect(r.errors[0].code).toBe('invalid_manifest_version');
  expect(r.errors[0].message).toBe(SHAPE_GUARD_MESSAGE);
}

describe('migrateManifest — version guard', () => {
  it('accepts the current version and returns the input identity', () => {
    const input = { manifestVersion: CURRENT_MANIFEST_VERSION, id: 'com.example.a' };
    const r = migrateManifest(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(input);
  });

  it.each([0, -1, -42])('rejects the non-positive version %s at the shape guard', (v) => {
    expectShapeGuardRejection(v);
  });

  it.each([1.5, 0.5, 2.0001])('rejects the non-integer version %s at the shape guard', (v) => {
    expectShapeGuardRejection(v);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite version %s at the shape guard',
    (v) => {
      expectShapeGuardRejection(v);
    },
  );

  it.each([undefined, null, 'one', true, [], {}])(
    'rejects the non-numeric version %s',
    (v) => {
      expect(errorCodes({ manifestVersion: v as unknown as number })).toContain(
        'invalid_manifest_version',
      );
    },
  );

  it('rejects a future version and names it in the message', () => {
    const r = migrateManifest({ manifestVersion: CURRENT_MANIFEST_VERSION + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe('manifestVersion');
      expect(r.errors[0].message).toContain(String(CURRENT_MANIFEST_VERSION + 1));
    }
  });

  it('points every rejection at the manifestVersion path', () => {
    for (const v of [0, 1.5, 'one', CURRENT_MANIFEST_VERSION + 1]) {
      const r = migrateManifest({ manifestVersion: v as unknown as number });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0].path).toBe('manifestVersion');
    }
  });
});

describe('migrateV1', () => {
  it('is re-exported from the migrations barrel and passes v1 through', () => {
    expect(typeof migrateV1).toBe('function');
    const input = { manifestVersion: 1, id: 'com.example.a' };
    const r = migrateV1(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(input);
  });
});
