/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `opts?: { caseSensitive?: boolean; tolerance?: number }` on
 * `stringOpMatches`/`setOpMatches`/`matchStringAnyNone`/`valueOpMatches`/
 * `numericOpMatches` (#5138 PR 3, plan §4 item 3) — added for the
 * information-validation engine, which is the only caller that ever passes
 * `opts`. Omitted `opts` must stay today's exact behaviour; `filter-match.
 * test.ts` and `filter-rules.test.ts` pin that separately (byte-for-byte, no
 * changes there). This file covers the two new dimensions themselves.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { stringOpMatches, numericOpMatches, valueOpMatches } from './filter-ops.js';

describe('filter-ops — caseSensitive opt (#5138)', () => {
  it('caseSensitive: true distinguishes "Basement level 1" from "Basement Level 1"', () => {
    assert.equal(
      stringOpMatches('eq', 'Basement level 1', 'Basement Level 1', undefined, { caseSensitive: true }),
      false,
      'exact case required — bSI #346',
    );
    assert.equal(
      stringOpMatches('eq', 'Basement level 1', 'Basement Level 1', undefined, { caseSensitive: false }),
      true,
      'caseSensitive:false still folds, same as omitted',
    );
  });

  it('omitted opts folds case exactly like before #5138 (default unchanged)', () => {
    assert.equal(stringOpMatches('eq', 'Basement level 1', 'Basement Level 1'), true);
    assert.equal(valueOpMatches('eq', 'IsExternal', 'ISEXTERNAL'), true);
  });

  it('caseSensitive applies to valueOpMatches (property/attribute values) too', () => {
    assert.equal(valueOpMatches('eq', 'IsExternal', 'isexternal', undefined, { caseSensitive: true }), false);
    assert.equal(valueOpMatches('eq', 'IsExternal', 'IsExternal', undefined, { caseSensitive: true }), true);
  });
});

describe('filter-ops — tolerance opt (#5138, bSI #418)', () => {
  it('relative tolerance 1e-6 accepts 100.00005 eq 100', () => {
    assert.equal(
      numericOpMatches('eq', 100.00005, 100, { tolerance: 1e-6 }),
      true,
      '|diff|=0.00005 <= 1e-6 * max(100,100,1) = 0.0001',
    );
  });

  it('default (no opts) uses the historical absolute 1e-9 epsilon, unchanged', () => {
    assert.equal(
      numericOpMatches('eq', 100.00005, 100),
      false,
      '|diff|=0.00005 >= 1e-9 — the pre-#5138 behaviour must not move',
    );
  });

  it('tolerance widens gte/lte at the boundary but leaves gt/lt strict', () => {
    assert.equal(numericOpMatches('gte', 99.99995, 100, { tolerance: 1e-6 }), true, 'within tolerance of the boundary');
    assert.equal(numericOpMatches('gte', 99.9, 100, { tolerance: 1e-6 }), false, 'genuinely below, tolerance does not rescue it');
    assert.equal(numericOpMatches('gt', 100, 100, { tolerance: 1e-6 }), false, 'gt stays strict even with tolerance set');
  });

  it('tolerance flows through valueOpMatches for property gt/gte/lt/lte', () => {
    assert.equal(valueOpMatches('gte', '99.99995', '100', undefined, { tolerance: 1e-6 }), true);
    assert.equal(valueOpMatches('gte', '99.99995', '100'), false, 'omitted opts = strict, unchanged');
  });
});
