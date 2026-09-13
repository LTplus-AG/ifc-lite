/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractLengthUnitScale, type EntityRef, type IfcSourceBytes } from '@ifc-lite/parser';

/**
 * Single validated read of `extractLengthUnitScale`, shared by every caller
 * in this package that turns the result into a coordinate multiplier.
 *
 * `extractLengthUnitScale` itself never throws and never returns a
 * non-positive or non-finite value for its OWN degenerate inputs — a
 * missing `IFCPROJECT`, an unresolved `UnitsInContext`, a garbled prefix —
 * every one of those routes back to its documented 1.0 fallback (see
 * `unit-extractor.ts`, pinned by `resolve-anchor-zero-scale.test.ts` which
 * mocks the export because the real implementation cannot produce a zero).
 * This wrapper is defense in depth against that contract changing, or
 * against a caller-supplied `entityIndex` whose `.get` throws — without it,
 * a caller trusting the return value verbatim would scale every length in
 * the model by 0, a negative number, or `NaN` with no warning.
 *
 * Returns `null` when the value cannot be trusted (thrown error, `NaN`,
 * non-finite, zero, or negative) rather than guessing on the caller's
 * behalf. Two call sites in this package used to duplicate this guard with
 * different strictness (`?? 1` here only excluded `null`/`undefined`,
 * `Number.isFinite(raw) && raw > 0` there) — on a store where the lookup
 * degenerated, one side would have refused while the other scaled by 0 or
 * 1. Centralizing the check means they cannot disagree again; each caller
 * still decides for itself what "unreliable" means for its own output —
 * `?? 1.0` to keep the existing metres-fallback behaviour, or an early
 * return to refuse the operation outright.
 */
export function safeLengthUnitScale(
  source: Uint8Array | IfcSourceBytes,
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined }; byType: Map<string, number[]> },
  context: string,
  projectId?: number,
): number | null {
  try {
    const raw = extractLengthUnitScale(source, entityIndex, projectId);
    if (Number.isFinite(raw) && raw > 0) return raw;
    console.warn(
      `${context}: failed to extract length unit scale; extractLengthUnitScale returned ${raw}`,
    );
    return null;
  } catch (error) {
    console.warn(`${context}: failed to extract length unit scale`, error);
    return null;
  }
}
