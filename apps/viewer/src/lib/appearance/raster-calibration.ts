/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PlaneCalibrationRequest } from './plane-calibration.js';

export type RasterCalibration = Pick<PlaneCalibrationRequest, 'sourcePoints' | 'distanceMetres'>;
export type RasterCalibrationFrame = Pick<PlaneCalibrationRequest, 'rasterToSource' | 'rasterSize'>;

/** UI coordinate conversion shared by image and document landmarks. Metric
 * placement remains in the canonical native calibration solver. */
function checked(frame: RasterCalibrationFrame) {
  const [a, b, c, d, e, f] = frame.rasterToSource;
  if (frame.rasterToSource.length !== 6 || !frame.rasterToSource.every(Number.isFinite)
    || frame.rasterSize.length !== 2 || !frame.rasterSize.every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('The source has an invalid raster coordinate frame.');
  }
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error('The source has a collapsed coordinate frame.');
  return { a, b, c, d, e, f, determinant };
}
export function rasterLandmarkAt(frame: RasterCalibrationFrame, fraction: readonly [number, number]): [number, number] {
  if (!fraction.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('Choose a point inside the source image.');
  const { a, b, c, d, e, f } = checked(frame);
  const x = fraction[0] * frame.rasterSize[0], y = fraction[1] * frame.rasterSize[1];
  return [a * x + c * y + e, b * x + d * y + f];
}
export function rasterLandmarkFraction(frame: RasterCalibrationFrame, point: readonly [number, number]): [number, number] {
  if (!point.every(Number.isFinite)) throw new Error('The source landmark must contain finite coordinates.');
  const { a, b, c, d, e, f, determinant } = checked(frame);
  const x = point[0] - e, y = point[1] - f;
  return [(d * x - c * y) / determinant / frame.rasterSize[0],
    (-b * x + a * y) / determinant / frame.rasterSize[1]];
}
/** Original image pixel coordinates form a stable frame without PDF metadata. */
export function imageCalibrationFrame(width: number, height: number): RasterCalibrationFrame {
  const frame: RasterCalibrationFrame = { rasterToSource: [1, 0, 0, 1, 0, 0], rasterSize: [width, height] };
  checked(frame);
  return frame;
}
