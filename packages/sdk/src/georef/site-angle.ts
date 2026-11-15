/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcCompoundPlaneAngleMeasure`, the type of IfcSite RefLatitude and
 * RefLongitude: `LIST [3:4] OF INTEGER`, degrees, minutes, seconds and the
 * optional millionths of a second. Its WHERE rules (IFC4 / IFC4X3
 * `MinutesInRange`, `SecondsInRange`, `MicrosecondsInRange`,
 * `ConsistentSign`; IFC2X3 WR1-WR4) require |minutes| < 60, |seconds| < 60,
 * |millionths| < 1 000 000 and every component of one sign: a southern or
 * western angle negates them all, so 33.5°S is (-33,-30,0,0). The reader
 * (`@ifc-lite/parser` `compoundPlaneAngleToDecimalDegrees`) takes the sign
 * from any negative component and sums the magnitudes, which inverts this.
 */

/** Millionths of an arc-second in a degree. */
const MICRO_ARC_SECONDS_PER_DEGREE = 3_600_000_000;

/**
 * Decimal degrees to `[degrees, minutes, seconds, millionths]`, rounded to
 * the millionth of a second (about 0.03 mm on the ground). Always four
 * components, so no precision is dropped; every component carries the sign.
 */
export function toCompoundPlaneAngle(decimalDegrees: number): [number, number, number, number] {
  if (!Number.isFinite(decimalDegrees)) throw new RangeError(`not a finite angle: ${decimalDegrees}`);
  const sign = decimalDegrees < 0 ? -1 : 1;
  let rest = Math.round(Math.abs(decimalDegrees) * MICRO_ARC_SECONDS_PER_DEGREE);
  const degrees = Math.floor(rest / MICRO_ARC_SECONDS_PER_DEGREE);
  rest -= degrees * MICRO_ARC_SECONDS_PER_DEGREE;
  const minutes = Math.floor(rest / 60_000_000);
  rest -= minutes * 60_000_000;
  const seconds = Math.floor(rest / 1_000_000);
  const millionths = rest - seconds * 1_000_000;
  // `+ 0` turns the -0 of a zero component of a negative angle into 0.
  return [sign * degrees + 0, sign * minutes + 0, sign * seconds + 0, sign * millionths + 0];
}

/** `[d, m, s, millionths?]` to decimal degrees, as the reader reads it; undefined when it is not 3-4 numbers. */
export function fromCompoundPlaneAngle(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4) return undefined;
  const parts = [...value.slice(0, 3), value[3] ?? 0];
  if (!parts.every((p): p is number => typeof p === 'number' && Number.isFinite(p))) return undefined;
  const sign = parts.some((p) => p < 0) ? -1 : 1;
  const [d, m, s, u] = parts.map(Math.abs);
  return sign * (d + m / 60 + (s + u / 1_000_000) / 3600);
}
