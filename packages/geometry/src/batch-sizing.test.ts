/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  TARGET_BATCH_MS,
  MIN_BATCH_JOBS,
  MAX_BATCH_JOBS,
  nextAdaptiveBatchJobs,
} from './batch-sizing.js';

describe('nextAdaptiveBatchJobs', () => {
  it('grows toward MAX on light geometry (fast call)', () => {
    // 256 jobs in 100 ms ⇒ 0.39 ms/job ⇒ projected ≫ MAX ⇒ clamp to MAX.
    expect(nextAdaptiveBatchJobs(256, 256, 100)).toBe(MAX_BATCH_JOBS);
  });

  it('shrinks toward MIN on dense CSG (slow call)', () => {
    // The reported steel model: ~45 ms/job ⇒ target 2 s ⇒ ~44 jobs ⇒ clamp up
    // to MIN. Either way it must collapse from MAX to the floor in one step.
    expect(nextAdaptiveBatchJobs(MAX_BATCH_JOBS, 256, 256 * 45)).toBe(MIN_BATCH_JOBS);
  });

  it('lands near TARGET_BATCH_MS in the adaptive mid-range', () => {
    // 5 ms/job: target 2000 ms ⇒ 400 jobs, but capped at MAX (256).
    expect(nextAdaptiveBatchJobs(MAX_BATCH_JOBS, 100, 100 * 5)).toBe(MAX_BATCH_JOBS);
    // 15 ms/job: target 2000 ms ⇒ 133 jobs — inside [MIN, MAX], returned as-is.
    const next = nextAdaptiveBatchJobs(MAX_BATCH_JOBS, 100, 100 * 15);
    expect(next).toBe(Math.floor(TARGET_BATCH_MS / 15));
    expect(next).toBeGreaterThanOrEqual(MIN_BATCH_JOBS);
    expect(next).toBeLessThanOrEqual(MAX_BATCH_JOBS);
  });

  it('a single dense call never exceeds the projected wall-time budget at steady state', () => {
    // At MIN_BATCH_JOBS the worst silent window is MIN × ms/job; confirm that
    // for the observed worst density it is far under the 30 s subsequent grace.
    const worstMsPerJob = 45;
    expect(MIN_BATCH_JOBS * worstMsPerJob).toBeLessThan(30_000);
  });

  it('never returns below MIN or above MAX', () => {
    for (const [jobs, ms] of [[256, 0.01], [256, 1e9], [1, 1e9], [1, 0.0001]] as const) {
      const n = nextAdaptiveBatchJobs(MAX_BATCH_JOBS, jobs, ms);
      expect(n).toBeGreaterThanOrEqual(MIN_BATCH_JOBS);
      expect(n).toBeLessThanOrEqual(MAX_BATCH_JOBS);
    }
  });

  it('returns the current size unchanged when nothing was measured (jobs <= 0)', () => {
    expect(nextAdaptiveBatchJobs(123, 0, 50)).toBe(123);
    expect(nextAdaptiveBatchJobs(MIN_BATCH_JOBS, -1, 50)).toBe(MIN_BATCH_JOBS);
  });

  it('treats a zero/sub-ms measurement as light → grows to MAX', () => {
    expect(nextAdaptiveBatchJobs(MIN_BATCH_JOBS, 256, 0)).toBe(MAX_BATCH_JOBS);
  });

  it('the transitional call (MAX size first hitting dense) stays under the browser grace', () => {
    // The one window adaptive sizing cannot pre-empt: a MAX-sized call that
    // crosses into a dense region before throughput is re-measured. Even at 2×
    // the observed worst density it must stay under the 30 s subsequent grace.
    expect(MAX_BATCH_JOBS * 90).toBeLessThan(30_000);
  });
});
