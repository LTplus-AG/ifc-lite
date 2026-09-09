/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PlaneCalibrationRequest } from '../plane-calibration.js';

function vector(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('Invalid drawing calibration vector.');
  }
  return [...value];
}
/** Fixed-size persistence validation only. Canonical Rust still derives the plane. */
export function ownCalibrationRecipe(value: unknown): PlaneCalibrationRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid drawing calibration recipe.');
  const v = value as Record<string, unknown>;
  const matrix = vector(v.rasterToSource, 6) as PlaneCalibrationRequest['rasterToSource'];
  const size = vector(v.rasterSize, 2) as PlaneCalibrationRequest['rasterSize'];
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || determinant === 0 || !size.every(n => Number.isSafeInteger(n) && n > 0)
    || typeof v.distanceMetres !== 'number' || !Number.isFinite(v.distanceMetres) || v.distanceMetres <= 0) {
    throw new Error('Drawing calibration requires an invertible raster frame, positive dimensions and distance.');
  }
  if (!Array.isArray(v.sourcePoints) || v.sourcePoints.length !== 2) throw new Error('Drawing calibration requires two landmarks.');
  const points = v.sourcePoints.map(point => vector(point, 2)) as PlaneCalibrationRequest['sourcePoints'];
  const span = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
  if (!Number.isFinite(span) || span === 0) throw new Error('Drawing calibration landmarks must be distinct.');
  const anchor = vector(v.worldAnchor, 3) as PlaneCalibrationRequest['worldAnchor'];
  const direction = vector(v.worldDirection, 3) as PlaneCalibrationRequest['worldDirection'];
  const normal = vector(v.planeNormal, 3) as PlaneCalibrationRequest['planeNormal'];
  const directionLength = Math.hypot(...direction), normalLength = Math.hypot(...normal);
  if (!Number.isFinite(directionLength) || !Number.isFinite(normalLength) || directionLength === 0 || normalLength === 0
    || Math.abs(direction.reduce((sum, n, i) => sum + (n / directionLength) * (normal[i] / normalLength), 0)) > 1e-8) {
    throw new Error('Drawing calibration requires a nonzero orthogonal world basis.');
  }
  const result: PlaneCalibrationRequest = { rasterToSource: matrix, rasterSize: size, sourcePoints: points,
    distanceMetres: v.distanceMetres, worldAnchor: anchor, worldDirection: direction, planeNormal: normal };
  for (const values of [matrix, size, ...points, points, anchor, direction, normal]) Object.freeze(values);
  return Object.freeze(result);
}
