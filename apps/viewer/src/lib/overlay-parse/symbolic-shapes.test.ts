/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createEmptyParseResult } from './symbolic-shapes.js';
import type { ParseResult } from './symbolic-shapes.js';

/**
 * The extraction in #2183 introduced exactly one new behaviour:
 * `createEmptyParseResult()`, which the hook now returns when the
 * `hasEntityType` pre-filter skips a store. Everything else in this module is
 * a byte-identical move and is already covered by
 * `hooks/useSymbolicAnnotations.test.ts` through the re-exports.
 *
 * What matters here is that the empty result is STRUCTURALLY complete and
 * FRESH per call. A missing bucket would throw at a consumer that iterates it;
 * a shared instance would let one model's annotations leak into another's
 * result, since callers push into these arrays.
 */
describe('createEmptyParseResult', () => {
  const KEYS: (keyof ParseResult)[] = [
    'byStorey', 'loose', 'looseTexts', 'looseFills',
    'gridByStorey', 'gridLoose', 'gridLooseTexts', 'gridLooseFills',
  ];

  it('has every bucket the annotation and grid paths read', () => {
    const result = createEmptyParseResult();
    assert.deepEqual(Object.keys(result).sort(), [...KEYS].sort());
  });

  it('starts every bucket empty', () => {
    const r = createEmptyParseResult();
    assert.equal(r.byStorey.size, 0);
    assert.equal(r.gridByStorey.size, 0);
    for (const k of ['loose', 'looseTexts', 'looseFills', 'gridLoose', 'gridLooseTexts', 'gridLooseFills'] as const) {
      assert.equal(r[k].length, 0, `${k} must start empty`);
    }
  });

  it('returns a FRESH result each call, not a shared singleton', () => {
    const a = createEmptyParseResult();
    const b = createEmptyParseResult();
    for (const k of KEYS) {
      assert.notEqual(a[k], b[k], `${k} must not be shared between results`);
    }
    // Mutating one must not be visible in the other: callers push into these.
    a.loose.push({} as never);
    a.byStorey.set(1, {} as never);
    assert.equal(b.loose.length, 0);
    assert.equal(b.byStorey.size, 0);
  });

  it('keeps the annotation and grid buckets separate within one result', () => {
    const r = createEmptyParseResult();
    assert.notEqual(r.byStorey, r.gridByStorey, 'issue #862 keeps these parallel');
    assert.notEqual(r.loose, r.gridLoose);
    assert.notEqual(r.looseTexts, r.gridLooseTexts);
    assert.notEqual(r.looseFills, r.gridLooseFills);
  });
});
