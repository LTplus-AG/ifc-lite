/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Option coercion for the split/merge stage (issue #1891).
 *
 * `diffModels` has no error channel for its options, so every knob is coerced
 * rather than validated. The property under test is that no input a JS caller
 * can supply produces a run that silently detects nothing — and that the piece
 * CAP's extra integer rule does not leak onto the three rates beside it, which
 * are fractions and would floor to zero.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SPLIT_PIECES,
  DEFAULT_SPLIT_PADDING_MIN,
  DEFAULT_SPLIT_PADDING_RATIO,
  DEFAULT_SPLIT_VOLUME_TOLERANCE,
  resolveSplitMergeSettings,
} from './split-merge-lanes.js';

describe('resolveSplitMergeSettings — the rates', () => {
  it('passes a usable value through untouched', () => {
    expect(
      resolveSplitMergeSettings({
        splitVolumeTolerance: 0.05,
        splitPaddingMin: 0.1,
        splitPaddingRatio: 0.02,
      }),
    ).toMatchObject({ volumeTolerance: 0.05, paddingMin: 0.1, paddingRatio: 0.02 });
  });

  it('is NOT subject to the piece cap’s integer rule', () => {
    // The whole reason the cap has its own helper. A shared one imposing an
    // integer floor would turn every default rate into zero: a zero tolerance
    // refuses every claim and a zero padding refuses every containment, so the
    // stage would silently detect nothing — the very failure the cap fix is
    // about, moved one field to the left.
    const resolved = resolveSplitMergeSettings({});
    expect(resolved.volumeTolerance).toBe(DEFAULT_SPLIT_VOLUME_TOLERANCE);
    expect(resolved.paddingMin).toBe(DEFAULT_SPLIT_PADDING_MIN);
    expect(resolved.paddingRatio).toBe(DEFAULT_SPLIT_PADDING_RATIO);
    expect(resolved.volumeTolerance).toBeGreaterThan(0);
    expect(resolved.paddingMin).toBeGreaterThan(0);
    expect(resolved.paddingRatio).toBeGreaterThan(0);
  });

  it('replaces a non-finite or negative rate with its default', () => {
    const resolved = resolveSplitMergeSettings({
      splitVolumeTolerance: Number.NaN,
      splitPaddingMin: -1,
      splitPaddingRatio: Infinity,
    });
    expect(resolved.volumeTolerance).toBe(DEFAULT_SPLIT_VOLUME_TOLERANCE);
    expect(resolved.paddingMin).toBe(DEFAULT_SPLIT_PADDING_MIN);
    expect(resolved.paddingRatio).toBe(DEFAULT_SPLIT_PADDING_RATIO);
  });
});

describe('resolveSplitMergeSettings — the piece cap', () => {
  const capOf = (maxSplitPieces?: number): number =>
    resolveSplitMergeSettings({ maxSplitPieces }).maxPieces;

  it('honours a usable cap', () => {
    expect(capOf(4)).toBe(4);
    expect(capOf(2)).toBe(2);
  });

  it('falls back to the default for a cap no split could ever meet', () => {
    // `0` and `1` pass a plain "finite and >= 0" coercion and then reject every
    // candidate in both lanes, because a candidate has at least two pieces by
    // definition. A split into fewer than two pieces is not a split, so these
    // are unachievable caps rather than tight ones.
    expect(capOf(0)).toBe(DEFAULT_MAX_SPLIT_PIECES);
    expect(capOf(1)).toBe(DEFAULT_MAX_SPLIT_PIECES);
    expect(capOf(1.9)).toBe(DEFAULT_MAX_SPLIT_PIECES);
    expect(capOf(-4)).toBe(DEFAULT_MAX_SPLIT_PIECES);
  });

  it('falls back for a non-finite cap, and for none at all', () => {
    expect(capOf(Number.NaN)).toBe(DEFAULT_MAX_SPLIT_PIECES);
    expect(capOf(Infinity)).toBe(DEFAULT_MAX_SPLIT_PIECES);
    expect(capOf(undefined)).toBe(DEFAULT_MAX_SPLIT_PIECES);
  });

  it('floors a fractional cap that is still achievable', () => {
    // A cap of 2.5 pieces is a cap of 2 pieces: counts are integers, so nothing
    // is invented by flooring and nothing is lost. Falling back here instead
    // would discard a cap the caller can perfectly well have meant.
    expect(capOf(2.5)).toBe(2);
    expect(capOf(9.99)).toBe(9);
  });

  it('never resolves below the minimum a candidate can have', () => {
    // The invariant behind all of the above, stated once: whatever a caller
    // supplies, the resolved cap can never be a number that rejects every
    // candidate the detector is able to build.
    for (const input of [undefined, 0, 1, 1.5, -1, Number.NaN, Infinity, -Infinity, 2, 2.5, 1e6]) {
      expect(capOf(input), `maxSplitPieces: ${input}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('does not silently override a cap the caller could have meant', () => {
    // The other half: the fallback must not swallow legitimate values. A cap of
    // 2 is achievable and stays 2, so "falls back" cannot be doing the work of
    // "ignores the option".
    expect(capOf(2)).not.toBe(DEFAULT_MAX_SPLIT_PIECES);
  });
});
