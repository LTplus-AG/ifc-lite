/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A host-supplied 4x4 model transform, read as the one kind of placement the
 * viewer can carry: a heading about the vertical axis, then a translation
 * (`rotation.ts` says why there is no tilt). Column-major, metres, IFC Z-up,
 * in the model's own IFC world frame: the heading turns about that frame's
 * origin (project coordinates 0,0,0), never about the viewer's render origin.
 *
 * Anything else (scale, mirroring, tilt, shear, a projective row) is refused,
 * not approximated: silently dropping part of a transform would put a model
 * somewhere the host did not ask for.
 *
 * No imports: the runtime configuration's parser reads this on the eager
 * start path (`runtime-config.ts`), where every byte is paid by every page.
 */

/** Slack for a matrix written out in decimal by another program. */
const TOLERANCE = 1e-6;

/** The heading (radians, counter-clockwise from above, in (-PI, PI]) and translation (metres, X/Y/Z) of a transform. */
export interface YawTransform {
  angle: number;
  translation: readonly [number, number, number];
}

const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

/** `matrix` as a heading plus translation, or `null` when it is not 16 finite numbers describing exactly that. */
export function yawTransform(matrix: unknown): YawTransform | null {
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
  // The renderer stores positions as f32: a translation past that range cannot be drawn.
  const translation = [m[12], m[13], m[14]] as const;
  if (!translation.every(value => Number.isFinite(Math.fround(value)))) return null;
  const angle = Math.atan2(sin, cos);
  // atan2 gives [-PI, PI]; fold -PI onto PI like `normalizeAngle`, and -0 onto 0.
  return { angle: angle === -Math.PI ? Math.PI : angle + 0, translation };
}
