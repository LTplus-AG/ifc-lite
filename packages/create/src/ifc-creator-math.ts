/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure utility functions and constants used by IfcCreator.
 * These have zero coupling to class state — they take inputs and return outputs.
 */

import type { Point3D } from './types.js';

// ============================================================================
// Internal helpers
// ============================================================================

/** Escape a string for STEP format */
export function esc(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/** Format a STEP line: #ID=TYPE(args); */
export function stepLine(id: number, type: string, args: string): string {
  return `#${id}=${type}(${args});`;
}

/** Serialize a number in STEP format (always with decimal point, no exponent notation) */
export function num(v: number): string {
  // Exponent notation (e.g. 1e-7) is not valid STEP — use fixed decimal
  const s = v.toString();
  if (s.includes('e') || s.includes('E')) return v.toFixed(10).replace(/0+$/, '0');
  return s.includes('.') ? s : s + '.';
}

/** Vector length */
export function vecLen(v: Point3D): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/**
 * IFC types that do NOT follow the IfcElement attribute layout (no Tag/PredefinedType).
 * addElement/addAxisElement skip Tag+PredefinedType for these types.
 */
export const NON_ELEMENT_TYPES = new Set([
  'IFCBUILDING', 'IFCSITE', 'IFCBUILDINGSTOREY', 'IFCPROJECT',
  'IFCSPACE', 'IFCZONE', 'IFCSYSTEM', 'IFCGROUP',
]);

/** Normalize vector — throws on zero-length (indicates geometry bug like Start === End) */
export function vecNorm(v: Point3D): Point3D {
  const len = vecLen(v);
  if (len === 0) throw new Error('Cannot normalize zero-length vector (check that Start and End are not identical)');
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Cross product */
export function vecCross(a: Point3D, b: Point3D): Point3D {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
