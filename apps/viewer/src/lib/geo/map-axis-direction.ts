/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place the viewer turns `IfcMapConversion.XAxisAbscissa` /
 * `XAxisOrdinate` into a rotation (#6700).
 *
 * The pair specifies the DIRECTION of the local X axis in the projected CRS.
 * Rotation comes from the angle of that vector; `Scale` (and the
 * `IfcMapConversionScaled` factors) are applied separately and exactly once.
 * So `(1, 0)` and `(2, 0)` are the same zero rotation, and an authored vector
 * must never contribute its LENGTH as a second map scale.
 *
 * Authored values are never rewritten: the model, the stored mutations and the
 * STEP export keep the vector as written, and only the arithmetic that USES it
 * goes through {@link resolveMapAxisDirection}.
 *
 * Agreement with the neutral spatial-reference boundary
 * (`packages/geometry/src/spatial-reference.ts`, whose private `normalizedAxis`
 * already divided by the length) is pinned by
 * `map-axis-direction.agreement.test.ts`, which feeds both the same vectors
 * including the degenerate ones.
 */

/** Cosine and sine of the authored X-axis direction, i.e. a unit vector. */
export interface MapAxisDirection {
  readonly a: number;
  readonly b: number;
}

/**
 * Shortest usable vector. Matches the `EPSILON` the spatial-reference
 * boundary applies to the same vector, so the two refuse the same inputs.
 */
const MIN_AXIS_LENGTH = 1e-12;

/**
 * Normalise an authored axis vector to its unit direction.
 *
 * An absent component takes the IFC default (`XAxisAbscissa` 1,
 * `XAxisOrdinate` 0), as every consumer did before. Returns `null`, an explicit
 * refusal, when the pair carries no direction: a non-finite component (the
 * whole pair is discarded, never half-repaired into a rotation the file did
 * not author) or a length below {@link MIN_AXIS_LENGTH}.
 */
export function resolveMapAxisDirection(
  abscissa: number | undefined,
  ordinate: number | undefined,
): MapAxisDirection | null {
  const a = abscissa ?? 1;
  const b = ordinate ?? 0;
  const length = Math.hypot(a, b);
  if (!Number.isFinite(length) || length < MIN_AXIS_LENGTH) return null;
  return { a: a / length, b: b / length };
}

/**
 * What a numeric delta helper returns for a refused axis, preserving the
 * outcome those helpers had before #6700: a non-finite component propagated as
 * NaN, and a zero-length vector produced a zero displacement. Callers that can
 * refuse (a lat/lon, a footprint, a bridge) return `null` instead.
 */
export function refusedAxisDelta(
  abscissa: number | undefined,
  ordinate: number | undefined,
): number {
  return Number.isFinite(abscissa ?? 1) && Number.isFinite(ordinate ?? 0) ? 0 : Number.NaN;
}
