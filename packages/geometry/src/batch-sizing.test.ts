/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BATCH_SIZING,
  resolveBatchSizing,
  nextAdaptiveBatchJobs,
} from './batch-sizing.js';

const CFG = DEFAULT_BATCH_SIZING;

describe('nextAdaptiveBatchJobs', () => {
  it('grows toward MAX on light geometry (fast call)', () => {
    // 512 jobs in 100 ms ⇒ 0.2 ms/job ⇒ projected ≫ MAX ⇒ clamp to MAX.
    expect(nextAdaptiveBatchJobs(CFG.maxJobs, 512, 100, CFG)).toBe(CFG.maxJobs);
  });

  it('lands near targetMs on dense CSG (slow call)', () => {
    // ~45 ms/job (the reported steel model) ⇒ target 8000 ms ⇒ ~177 jobs,
    // which is inside [min, max] and returned as-is.
    const next = nextAdaptiveBatchJobs(CFG.maxJobs, 512, 512 * 45, CFG);
    expect(next).toBe(Math.floor(CFG.targetMs / 45));
    expect(next).toBeGreaterThanOrEqual(CFG.minJobs);
    expect(next).toBeLessThanOrEqual(CFG.maxJobs);
  });

  it('collapses to MIN on pathologically dense geometry', () => {
    // 1000 ms/job ⇒ target 8000 ⇒ 8 jobs ⇒ clamp up to MIN.
    expect(nextAdaptiveBatchJobs(CFG.maxJobs, 64, 64 * 1000, CFG)).toBe(CFG.minJobs);
  });

  it('never returns below MIN or above MAX', () => {
    for (const [jobs, ms] of [[512, 0.01], [512, 1e9], [1, 1e9], [1, 0.0001]] as const) {
      const n = nextAdaptiveBatchJobs(CFG.maxJobs, jobs, ms, CFG);
      expect(n).toBeGreaterThanOrEqual(CFG.minJobs);
      expect(n).toBeLessThanOrEqual(CFG.maxJobs);
    }
  });

  it('returns the current size unchanged when nothing was measured (jobs <= 0)', () => {
    expect(nextAdaptiveBatchJobs(123, 0, 50, CFG)).toBe(123);
    expect(nextAdaptiveBatchJobs(CFG.minJobs, -1, 50, CFG)).toBe(CFG.minJobs);
  });

  it('treats a zero/sub-ms measurement as light → grows to MAX', () => {
    expect(nextAdaptiveBatchJobs(CFG.minJobs, 512, 0, CFG)).toBe(CFG.maxJobs);
  });

  it('honours a custom config', () => {
    const cfg = resolveBatchSizing({ targetMs: 2000, minJobs: 32, maxJobs: 128 });
    // 10 ms/job ⇒ 200 projected ⇒ clamp to custom max 128.
    expect(nextAdaptiveBatchJobs(128, 100, 1000, cfg)).toBe(128);
    // 100 ms/job ⇒ 20 projected ⇒ clamp up to custom min 32.
    expect(nextAdaptiveBatchJobs(128, 100, 10000, cfg)).toBe(32);
  });

  it('the steady-state silent window stays under the browser grace at default config', () => {
    // The dominant window is one targetMs-budgeted call; confirm it (and the
    // transitional max-size call at the observed worst density) sit under the
    // 40 s browser subsequent grace (see watchdog.ts) with headroom.
    expect(CFG.targetMs).toBeLessThan(40_000);
    expect(CFG.maxJobs * 45).toBeLessThan(40_000); // transitional, ~45 ms/job
  });
});

describe('resolveBatchSizing', () => {
  it('returns defaults for undefined/empty', () => {
    expect(resolveBatchSizing()).toEqual(DEFAULT_BATCH_SIZING);
    expect(resolveBatchSizing(null)).toEqual(DEFAULT_BATCH_SIZING);
    expect(resolveBatchSizing({})).toEqual(DEFAULT_BATCH_SIZING);
  });

  it('drops non-finite/non-positive fields back to defaults', () => {
    expect(resolveBatchSizing({ targetMs: 0, minJobs: -5, maxJobs: NaN })).toEqual(DEFAULT_BATCH_SIZING);
    expect(resolveBatchSizing({ targetMs: Infinity })).toEqual(DEFAULT_BATCH_SIZING);
  });

  it('enforces minJobs <= maxJobs', () => {
    const cfg = resolveBatchSizing({ minJobs: 400, maxJobs: 100 });
    expect(cfg.minJobs).toBe(400);
    expect(cfg.maxJobs).toBe(400);
  });

  it('floors fractional values', () => {
    expect(resolveBatchSizing({ targetMs: 1234.9, minJobs: 33.7, maxJobs: 200.1 }))
      .toEqual({ targetMs: 1234, minJobs: 33, maxJobs: 200 });
  });
});
