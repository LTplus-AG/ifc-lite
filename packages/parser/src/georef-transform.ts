/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local <-> world side of georeferencing: the 4x4 matrix an
 * IfcMapConversion defines, the two point transforms that use it, and the
 * human-readable description of the resulting coordinate system. Split out of
 * georef-extractor.ts, which reads the entities; this file only does the
 * arithmetic on what that produced.
 */

import type { MapConversion, GeoreferenceInfo } from './georef-extractor.js';

/**
 * Compute 4x4 transformation matrix from local to world coordinates
 */
export function computeTransformMatrix(mapConversion: MapConversion): number[] {
  const { eastings, northings, orthogonalHeight, xAxisAbscissa, xAxisOrdinate, scale } = mapConversion;

  // Default scale to 1.0 if not specified
  const s = scale || 1.0;

  // Compute rotation angle from X-axis direction
  let angle = 0;
  if (xAxisAbscissa !== undefined && xAxisOrdinate !== undefined) {
    angle = Math.atan2(xAxisOrdinate, xAxisAbscissa);
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Build 4x4 transformation matrix (IfcMapConversion applies the one
  // Scale equally to x, y AND z, then rotates about z, then translates):
  // [scale*cos  -scale*sin  0      eastings  ]
  // [scale*sin   scale*cos  0      northings ]
  // [0           0          scale  height    ]
  // [0           0          0      1         ]

  return [
    s * cos,  s * sin,  0,  0,
    -s * sin, s * cos,  0,  0,
    0,        0,        s,  0,
    eastings, northings, orthogonalHeight, 1,
  ];
}

/**
 * Transform a point from local to world coordinates
 */
export function transformToWorld(
  localPoint: [number, number, number],
  georef: GeoreferenceInfo
): [number, number, number] | null {
  if (!georef.transformMatrix) {
    return null;
  }

  const [x, y, z] = localPoint;
  const m = georef.transformMatrix;

  // Apply transformation: [x', y', z', 1] = [x, y, z, 1] * M
  const xWorld = m[0] * x + m[4] * y + m[8] * z + m[12];
  const yWorld = m[1] * x + m[5] * y + m[9] * z + m[13];
  const zWorld = m[2] * x + m[6] * y + m[10] * z + m[14];

  return [xWorld, yWorld, zWorld];
}

/**
 * Transform a point from world to local coordinates
 */
export function transformToLocal(
  worldPoint: [number, number, number],
  georef: GeoreferenceInfo
): [number, number, number] | null {
  if (!georef.transformMatrix) {
    return null;
  }

  // Compute inverse transformation
  const m = georef.transformMatrix;
  const [xWorld, yWorld, zWorld] = worldPoint;

  // Extract rotation and scale
  const scale = georef.mapConversion?.scale || 1.0;
  const angle = Math.atan2(m[1], m[0]);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const invScale = 1.0 / scale;

  // Apply inverse translation
  const xTrans = xWorld - m[12];
  const yTrans = yWorld - m[13];
  const zTrans = zWorld - m[14];

  // Apply inverse rotation and scale
  const x = invScale * (cos * xTrans - sin * yTrans);
  const y = invScale * (sin * xTrans + cos * yTrans);
  // Scale applies to z too (IfcMapConversion scales all three axes).
  const z = invScale * zTrans;

  return [x, y, z];
}

/**
 * Get coordinate system description
 */
export function getCoordinateSystemDescription(georef: GeoreferenceInfo): string {
  if (!georef.hasGeoreference) {
    return 'Local Engineering Coordinates';
  }

  const parts: string[] = [];

  if (georef.projectedCRS) {
    parts.push(georef.projectedCRS.name);
    if (georef.projectedCRS.mapProjection) {
      parts.push(`(${georef.projectedCRS.mapProjection})`);
    }
    if (georef.projectedCRS.geodeticDatum) {
      parts.push(`Datum: ${georef.projectedCRS.geodeticDatum}`);
    }
  }

  if (georef.mapConversion) {
    const { eastings, northings, orthogonalHeight } = georef.mapConversion;
    const originLabel = georef.source === 'siteLocation' ? 'Site' : 'Origin';
    parts.push(`${originLabel}: (${eastings.toFixed(2)}, ${northings.toFixed(2)}, ${orthogonalHeight.toFixed(2)})`);
  }

  return parts.join(' ');
}
