/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Revert-oracle witness for `realRtcAnchorOf` (#4897).
 *
 * `world-frame.test.ts` covers the actual rebase behaviour, but it also
 * imports `rtc-rebase.js` (wholly new in this change) at module scope, so a
 * revert deletes that file and the whole test file dies at import
 * (`Cannot find module`) instead of failing an assertion — a load failure,
 * not a witness. This file avoids that by never importing `rtc-rebase.js`.
 *
 * A revert also drops `realRtcAnchorOf` itself, since it too is new here.
 * Calling a removed export throws `TypeError: ... is not a function` — Vite
 * binds a missing named import to `undefined` rather than failing at
 * import, so the call happens, but `check-test-revert-oracle.mjs` reads
 * that exact message as a load failure too (its own documented rationale:
 * that shape is usually a dead import, not a real red). `readRealRtcAnchorOf`
 * below guards the call so a missing export degrades to `undefined` instead
 * of throwing, turning a revert into a plain value mismatch the oracle
 * reads as a genuine assertion, the same technique
 * `registry.cost-registration.test.ts` uses for a data read instead of a
 * function call.
 */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo } from './coordinate-types.js';
import * as WorldFrame from './world-frame.js';

function info(wasmRtcOffset: CoordinateInfo['wasmRtcOffset']): CoordinateInfo {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: box,
    shiftedBounds: box,
    hasLargeCoordinates: false,
    wasmRtcOffset,
  };
}

function readRealRtcAnchorOf(
  candidate: Parameters<typeof WorldFrame.realRtcAnchorOf>[0],
): ReturnType<typeof WorldFrame.realRtcAnchorOf> | undefined {
  return typeof WorldFrame.realRtcAnchorOf === 'function'
    ? WorldFrame.realRtcAnchorOf(candidate)
    : undefined;
}

describe('realRtcAnchorOf', () => {
  it('returns the real anchor a model already carries', () => {
    const offset = { x: 1, y: 2, z: 3 };
    const candidate = { loadedAt: 0, geometryResult: { coordinateInfo: info(offset) } };
    expect(readRealRtcAnchorOf(candidate)).toEqual(offset);
  });

  it('returns null for a model meshed raw (no anchor yet)', () => {
    const candidate = { loadedAt: 0, geometryResult: { coordinateInfo: info(undefined) } };
    expect(readRealRtcAnchorOf(candidate)).toBeNull();
  });

  it('returns null when the model has no geometry result yet, or is absent', () => {
    expect(readRealRtcAnchorOf({ loadedAt: 0 })).toBeNull();
    expect(readRealRtcAnchorOf(null)).toBeNull();
    expect(readRealRtcAnchorOf(undefined)).toBeNull();
  });
});
