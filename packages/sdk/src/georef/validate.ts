/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Input checks for `bim.georef` writes. Every refusal names the input that
 * is missing or wrong; nothing here substitutes a default for a value the
 * caller did not give (a CRS, a unit, a scale, a factor).
 */

import { isExpressibleMapUnit } from '@ifc-lite/export';
import { normalizeMapUnitName } from '@ifc-lite/parser';
import { GeoreferencingError, type GeorefMapConversionAttributes } from './types.js';

/** Two rotations closer than this (radians, ~0.2 arc-seconds) are the same rotation. */
const ROTATION_TOLERANCE_RAD = 1e-6;

export function requireNumber(value: unknown, path: string, opts: { positive?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GeoreferencingError('INVALID_INPUT', `${path} must be a finite number, got ${JSON.stringify(value)}.`, [path]);
  }
  if (opts.positive && !(value > 0)) {
    throw new GeoreferencingError('INVALID_INPUT', `${path} must be greater than 0, got ${value}.`, [path]);
  }
  return value;
}

export function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GeoreferencingError('INVALID_INPUT', `${path} must be a non-empty string, got ${JSON.stringify(value)}.`, [path]);
  }
  return value;
}

/**
 * A map unit the writer can express, in the canonical spelling the readers
 * report (`millimetre` -> `MILLIMETRE`), else a refusal listing what it can.
 */
export function requireMapUnit(value: unknown, path = 'ProjectedCRS.MapUnit'): string {
  const unit = requireText(value, path);
  if (!isExpressibleMapUnit(unit)) {
    throw new GeoreferencingError(
      'INVALID_INPUT',
      `${path} ${JSON.stringify(unit)} is not a length unit ifc-lite can write: use METRE (with any SI prefix, e.g. MILLIMETRE), FOOT or US SURVEY FOOT.`,
      [path],
    );
  }
  return normalizeMapUnitName(unit);
}

/**
 * Refuse a key `fields` does not list, so a typo or a guessed name
 * (`Rotation`, `scale`, `Zone`) is never silently dropped. `path` prefixes
 * the key in the message and in `missing`; '' for the top level.
 */
export function rejectUnknownKeys(obj: object | undefined, fields: readonly string[], path: string): void {
  // `Object.keys(42)` is empty, so a number, text or list would pass for "nothing to refuse" and be dropped silently.
  if (obj !== undefined && obj !== null && (typeof obj !== 'object' || Array.isArray(obj))) {
    throw new GeoreferencingError('INVALID_INPUT', `${path || 'the input'} must be an object, got ${JSON.stringify(obj)}.`, [path]);
  }
  for (const key of Object.keys(obj ?? {})) {
    if (!fields.includes(key)) {
      const at = path ? `${path}.${key}` : key;
      const what = path ? 'an attribute bim.georef writes' : 'a bim.georef input';
      throw new GeoreferencingError('INVALID_INPUT', `${at} is not ${what} (known: ${fields.join(', ')}).`, [at]);
    }
  }
}

/** Throw MISSING_INPUT for every listed path whose value is undefined. */
export function requirePresent(entries: Array<[string, unknown]>, what: string): void {
  const missing = entries.filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) {
    throw new GeoreferencingError('MISSING_INPUT', `${what} needs ${missing.join(', ')}.`, missing);
  }
}

export interface ResolvedRotation {
  /** Both set, or both absent (no rotation stored). */
  XAxisAbscissa?: number;
  XAxisOrdinate?: number;
  /** How the rotation was given, for the report. */
  given: 'angle' | 'vector' | 'angle+vector' | 'none';
}

/** Snap floating noise (cos 90° = 6e-17) to an exact zero. */
function clean(n: number): number {
  return Math.abs(n) < 1e-15 ? 0 : n;
}

export function degreesOf(abscissa: number, ordinate: number): number {
  return (Math.atan2(ordinate, abscissa) * 180) / Math.PI;
}

/**
 * The rotation to write, from an angle, an XAxisAbscissa/XAxisOrdinate
 * vector, or both. Both must agree; one vector component alone is refused,
 * as is the zero vector, which has no direction.
 */
export function resolveRotation(
  mc: Partial<Pick<GeorefMapConversionAttributes, 'XAxisAbscissa' | 'XAxisOrdinate'>>,
  rotationDegrees: number | undefined,
): ResolvedRotation {
  const hasA = mc.XAxisAbscissa !== undefined;
  const hasO = mc.XAxisOrdinate !== undefined;
  if (hasA !== hasO) {
    const missing = hasA ? 'MapConversion.XAxisOrdinate' : 'MapConversion.XAxisAbscissa';
    throw new GeoreferencingError(
      'MISSING_INPUT',
      `A rotation given as a vector needs both XAxisAbscissa and XAxisOrdinate; ${missing} is missing (or give rotationDegrees instead).`,
      [missing],
    );
  }
  const angle = rotationDegrees === undefined ? undefined : requireNumber(rotationDegrees, 'rotationDegrees');
  // A full turn either way covers every rotation; a larger angle is a typo or
  // an overflow risk (1e308 * pi turns the axis into NaN), never a survey value.
  if (angle !== undefined && Math.abs(angle) > 360) {
    throw new GeoreferencingError('INVALID_INPUT', `rotationDegrees must lie between -360 and 360, got ${angle}.`, ['rotationDegrees']);
  }
  if (!hasA) {
    if (angle === undefined) return { given: 'none' };
    const rad = (angle * Math.PI) / 180;
    return { XAxisAbscissa: clean(Math.cos(rad)), XAxisOrdinate: clean(Math.sin(rad)), given: 'angle' };
  }
  const a = requireNumber(mc.XAxisAbscissa, 'MapConversion.XAxisAbscissa');
  const o = requireNumber(mc.XAxisOrdinate, 'MapConversion.XAxisOrdinate');
  if (a === 0 && o === 0) {
    throw new GeoreferencingError(
      'INVALID_INPUT',
      'XAxisAbscissa and XAxisOrdinate are both 0: that vector has no direction, so it states no rotation.',
      ['MapConversion.XAxisAbscissa', 'MapConversion.XAxisOrdinate'],
    );
  }
  if (angle === undefined) return { XAxisAbscissa: a, XAxisOrdinate: o, given: 'vector' };
  let diff = Math.atan2(o, a) - (angle * Math.PI) / 180;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  if (Math.abs(diff) > ROTATION_TOLERANCE_RAD) {
    throw new GeoreferencingError(
      'CONTRADICTION',
      `rotationDegrees ${angle} disagrees with XAxisAbscissa/XAxisOrdinate (${a}, ${o}), which point at ${degreesOf(a, o)}°. Give one of them, or make them agree.`,
      ['rotationDegrees', 'MapConversion.XAxisAbscissa', 'MapConversion.XAxisOrdinate'],
    );
  }
  return { XAxisAbscissa: a, XAxisOrdinate: o, given: 'angle+vector' };
}

/**
 * FactorX/Y/Z: all three or none, each > 0, and only where the file's
 * FILE_SCHEMA declares `IfcMapConversionScaled` (IFC4X3 / IFC4X3_ADD2).
 * `schema` is that identifier, for the message.
 */
export function resolveFactors(
  mc: Partial<GeorefMapConversionAttributes>,
  schema: string,
  supportsScaled: boolean,
): [number, number, number] | null {
  const given: Array<[string, unknown]> = [
    ['MapConversion.FactorX', mc.FactorX],
    ['MapConversion.FactorY', mc.FactorY],
    ['MapConversion.FactorZ', mc.FactorZ],
  ];
  if (given.every(([, v]) => v === undefined)) return null;
  if (!supportsScaled) {
    throw new GeoreferencingError(
      'UNSUPPORTED_SCHEMA',
      `FactorX/FactorY/FactorZ are written as IfcMapConversionScaled, which only FILE_SCHEMA IFC4X3 / IFC4X3_ADD2 declare (not the IFC4X3 release candidates, IFC4 or IFC2X3); this model is ${schema || 'of unknown schema'}. Leave the factors out (Scale is available in every schema) or convert the model to IFC4X3_ADD2 first.`,
      given.filter(([, v]) => v !== undefined).map(([k]) => k),
    );
  }
  requirePresent(given, 'IfcMapConversionScaled (all three factors are mandatory)');
  return given.map(([path, v]) => requireNumber(v, path, { positive: true })) as [number, number, number];
}

/** `EPSG:2056` from 2056, for the CLI/MCP `epsg` convenience input. */
export function epsgName(code: unknown): string {
  const n = typeof code === 'string' && /^\d+$/.test(code.trim()) ? Number(code.trim()) : code;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new GeoreferencingError('INVALID_INPUT', `An EPSG code must be a positive integer, got ${JSON.stringify(code)}.`, ['epsg']);
  }
  return `EPSG:${n}`;
}
