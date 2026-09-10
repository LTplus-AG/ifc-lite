/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceAssignment } from './types.js';
import { ownPdfRasterRecipe } from '../pdf/own-raster-recipe.js';
import { rasterLandmarkAt } from '../raster-calibration.js';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid assignment source.');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('Invalid assignment source identifier.');
  return value;
}
function number(value: unknown, positive = false, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0 || integer && !Number.isSafeInteger(value)) {
    throw new Error('Invalid assignment source measurement.');
  }
  return value;
}
function array(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error('Invalid assignment source coordinates.');
  return value.map(n => number(n));
}
function pair(value: unknown): [number, number] { const a = array(value, 2); return [a[0], a[1]]; }
function affine(value: unknown): [number, number, number, number, number, number] {
  const a = array(value, 6); return [a[0], a[1], a[2], a[3], a[4], a[5]];
}
/** Copy validated source metadata, excluding ephemeral thumbnail URLs and live bytes. */
export function ownAssignmentSource(value: unknown): AppearanceAssignment['source'] {
  const v = record(value);
  const source: AppearanceAssignment['source'] = { id: string(v.id), name: string(v.name),
    width: number(v.width, true, true), height: number(v.height, true, true) };
  if (v.assetId !== undefined) source.assetId = string(v.assetId);
  if (!/^[a-f0-9]{64}$/.test(source.assetId ?? source.id) || source.width > 16384 || source.height > 16384) {
    throw new Error('Assignment source needs a bounded raster and exact image digest.');
  }
  if (v.calibration !== undefined) {
    const c = record(v.calibration);
    if (!Array.isArray(c.sourcePoints) || c.sourcePoints.length !== 2) throw new Error('Source calibration needs two landmarks.');
    source.calibration = { sourcePoints: [pair(c.sourcePoints[0]), pair(c.sourcePoints[1])], distanceMetres: number(c.distanceMetres, true) };
  }
  if (v.calibrationFrame !== undefined) {
    const f = record(v.calibrationFrame);
    source.calibrationFrame = { rasterToSource: affine(f.rasterToSource), rasterSize: pair(f.rasterSize) };
    rasterLandmarkAt(source.calibrationFrame, [0, 0]);
  }
  if (v.pdf !== undefined) {
    const p = record(v.pdf);
    source.pdf = { documentKey: string(p.documentKey), recipe: ownPdfRasterRecipe(p.recipe) };
    if (p.documentSha256 !== undefined) {
      const digest = string(p.documentSha256);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid original PDF source digest.');
      source.pdf.documentSha256 = digest;
    }
    if (source.pdf.recipe.pixelWidth !== source.width || source.pdf.recipe.pixelHeight !== source.height) {
      throw new Error('The PDF derivative dimensions differ from the saved source.');
    }
  }
  return source;
}
