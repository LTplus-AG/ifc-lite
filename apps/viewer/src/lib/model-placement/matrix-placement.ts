/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A host-supplied 4x4 model transform, read as the one kind of placement the
 * viewer can carry: a heading about the vertical axis, then a translation
 * (`rotation.ts` says why there is no tilt). Column-major, metres, engineering
 * Z-up, in the workspace frame placements already use (`translation.ts`).
 *
 * Anything else (scale, mirroring, tilt, shear, a projective row) is refused,
 * not approximated: silently dropping part of a transform would put a model
 * somewhere the host did not ask for.
 */

import { finiteTranslation, type Translation } from './translation.js';
import { normalizeAngle, ZERO_ROTATION, type ModelRotation } from './rotation.js';

/** Slack for a matrix written out in decimal by another program. */
const TOLERANCE = 1e-6;

export interface MatrixPlacement {
  translation: Translation;
  rotation: ModelRotation;
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/** The placement `matrix` describes, or `null` when it is not 16 finite numbers or not a vertical-axis rigid motion. */
export function placementFromMatrix(matrix: unknown): MatrixPlacement | null {
  if (!Array.isArray(matrix) || matrix.length !== 16) return null;
  if (!matrix.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) return null;
  const m = matrix as readonly number[];
  // Column-major: m[c * 4 + r]. Bottom row (r = 3) must be 0 0 0 1.
  if (!near(m[3], 0) || !near(m[7], 0) || !near(m[11], 0) || !near(m[15], 1)) return null;
  // Z stays vertical and unscaled: no tilt, no vertical scale.
  if (!near(m[2], 0) || !near(m[6], 0) || !near(m[8], 0) || !near(m[9], 0) || !near(m[10], 1)) return null;
  // The horizontal block is a rotation [c -s; s c]: no scale, shear or mirror.
  const cos = m[0], sin = m[1];
  if (!near(m[5], cos) || !near(m[4], -sin) || !near(cos * cos + sin * sin, 1)) return null;
  const translation: Translation = [m[12], m[13], m[14]];
  // Same renderable bound every other placement entry checks (`assertRenderableTranslation`).
  if (!finiteTranslation(translation) || !translation.every((value) => Number.isFinite(Math.fround(value)))) return null;
  const angle = normalizeAngle(Math.atan2(sin, cos));
  // A zero heading is ZERO_ROTATION, so an identity matrix stores the same placement a fresh model has.
  return { translation, rotation: angle === 0 ? ZERO_ROTATION : { angle, pivot: [0, 0, 0] } };
}
