/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  LAS_CLASS_COUNT,
  accumulateClassificationCounts,
  classificationCountEntries,
  createClassificationCounts,
  lasClassificationName,
} from './classification.js';

describe('lasClassificationName', () => {
  it('maps the ASPRS standard codes to their spec names', () => {
    expect(lasClassificationName(0)).toBe('Created, never classified');
    expect(lasClassificationName(1)).toBe('Unclassified');
    expect(lasClassificationName(2)).toBe('Ground');
    expect(lasClassificationName(6)).toBe('Building');
    expect(lasClassificationName(9)).toBe('Water');
    expect(lasClassificationName(17)).toBe('Bridge deck');
    expect(lasClassificationName(18)).toBe('High noise');
  });

  it('labels the ranges the spec leaves unnamed', () => {
    // 8 and 12 are Reserved since LAS 1.4 (were Model Key-point / Overlap).
    expect(lasClassificationName(8)).toBe('Reserved');
    expect(lasClassificationName(12)).toBe('Reserved');
    // 19..22 were added by LAS 1.4 R13.
    expect(lasClassificationName(19)).toBe('Overhead structure');
    expect(lasClassificationName(22)).toBe('Temporal exclusion');
    // 23..63 reserved for ASPRS definition.
    expect(lasClassificationName(23)).toBe('Reserved');
    expect(lasClassificationName(63)).toBe('Reserved');
    // 64..255 user definable.
    expect(lasClassificationName(64)).toBe('User defined');
    expect(lasClassificationName(255)).toBe('User defined');
  });

  it('rejects values a classification byte cannot hold', () => {
    expect(lasClassificationName(-1)).toBe('Unknown');
    expect(lasClassificationName(256)).toBe('Unknown');
    expect(lasClassificationName(2.5)).toBe('Unknown');
    expect(lasClassificationName(Number.NaN)).toBe('Unknown');
  });
});

describe('classification count aggregation (#1783)', () => {
  it('aggregates per-class counts across multiple chunks', () => {
    const counts = createClassificationCounts();
    expect(counts.length).toBe(LAS_CLASS_COUNT);

    const first = accumulateClassificationCounts(counts, {
      classifications: new Uint8Array([2, 2, 6, 255]),
      pointCount: 4,
    });
    const second = accumulateClassificationCounts(counts, {
      classifications: new Uint8Array([2, 0]),
      pointCount: 2,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(counts[0]).toBe(1);
    expect(counts[2]).toBe(3);
    expect(counts[6]).toBe(1);
    expect(counts[255]).toBe(1);
  });

  it('reports chunks without classifications and leaves counts untouched', () => {
    const counts = createClassificationCounts();
    const saw = accumulateClassificationCounts(counts, {
      classifications: undefined,
      pointCount: 100,
    });
    expect(saw).toBe(false);
    expect(counts.every((c) => c === 0)).toBe(true);
  });

  it('never reads past a short classifications buffer', () => {
    const counts = createClassificationCounts();
    // pointCount lies (says 10, buffer holds 3) — a malformed source
    // must not push undefined-index increments into the histogram.
    accumulateClassificationCounts(counts, {
      classifications: new Uint8Array([5, 5, 5]),
      pointCount: 10,
    });
    expect(counts[5]).toBe(3);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('lists only non-zero entries, ascending by code', () => {
    const counts = createClassificationCounts();
    accumulateClassificationCounts(counts, {
      classifications: new Uint8Array([64, 2, 64, 18]),
      pointCount: 4,
    });
    expect(classificationCountEntries(counts)).toEqual([
      { classId: 2, count: 1 },
      { classId: 18, count: 1 },
      { classId: 64, count: 2 },
    ]);
  });
});
