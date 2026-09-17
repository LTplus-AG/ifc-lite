/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { finiteTranslation, subtractTranslation, ZERO_TRANSLATION, type Translation } from './translation.js';

/**
 * A whole-model rotation about the workspace VERTICAL axis only.
 *
 * Repositioning a model in practice means seating a building on a site: a
 * heading change plus an offset. Tilting a model out of plumb is not that job,
 * so there is deliberately no second or third axis here — `angle` is a yaw and
 * nothing else, and the panel says so.
 *
 * `angle` is radians, positive counter-clockwise seen from above. That is an
 * IFC yaw about +Z, which in the renderer's Y-up frame is the SAME angle about
 * +Y — the convention `Scene.rotateMeshesForEntity` and `rotateEntity` already
 * use for per-entity yaw, and this must not become a second one.
 *
 * `pivot` is in engineering X/Y/Z metres, in the model's UN-TRANSLATED frame as
 * stored on a placement (`rotatePlacements` converts the workspace point a user
 * enters with `pivotInModelFrame`). Its Z is carried so
 * the value round-trips through the manifest unchanged, but a vertical-axis
 * rotation cannot read it: only the horizontal pair positions the axis.
 */
export interface ModelRotation {
  angle: number;
  pivot: Translation;
}

export const ZERO_ROTATION: ModelRotation = Object.freeze({ angle: 0, pivot: ZERO_TRANSLATION });

export function finiteRotation(value: unknown): value is ModelRotation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { angle?: unknown; pivot?: unknown };
  return typeof candidate.angle === 'number' && Number.isFinite(candidate.angle)
    && finiteTranslation(candidate.pivot);
}

export function equalRotation(a: ModelRotation, b: ModelRotation): boolean {
  // A pivot only matters while an angle is turning: two zero-angle rotations are
  // the same placement however far apart their pivots sit, and calling them
  // different would re-bake geometry that has not moved.
  if (a.angle !== b.angle) return false;
  return a.angle === 0 || a.pivot.every((value, index) => value === b.pivot[index]);
}

export function isZeroRotation(value: ModelRotation): boolean {
  return value.angle === 0;
}

const TWO_PI = Math.PI * 2;

/** Wrap to (-180°, 180°] so a stored heading cannot drift without bound as it is
 * edited, and so the panel always shows the short way round. */
export function normalizeAngle(radians: number): number {
  if (!Number.isFinite(radians)) throw new Error('Enter a finite rotation angle in degrees.');
  const wrapped = radians - TWO_PI * Math.floor((radians + Math.PI) / TWO_PI);
  // Inputs that are odd multiples of PI land exactly on -PI; fold those to +PI
  // so 180 and -180 are one value and `equalRotation` cannot split them.
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export function degreesToRadians(degrees: number): number {
  return normalizeAngle((degrees * Math.PI) / 180);
}

export function radiansToDegrees(radians: number): number {
  return (normalizeAngle(radians) * 180) / Math.PI;
}

/** Full-string parsing of a degree entry, under the same no-expressions,
 * no-trailing-junk rule as `parseMoveLength`. A decimal comma is accepted when
 * it is the sole decimal separator; a `°`/`deg` suffix is allowed. */
export function parseRotationDegrees(text: string): number {
  const match = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(?:°|deg|degrees)?\s*$/i.exec(text);
  if (!match) throw new Error('Enter a rotation in degrees, for example 90 or -22.5.');
  const degrees = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(degrees)) throw new Error('Enter a finite rotation angle in degrees.');
  return degreesToRadians(degrees);
}

/**
 * Convert a point observed on the PLACED model into the model's own
 * un-translated frame, which is the frame a pivot must be in.
 *
 * The order of operations is rotate-about-pivot, then translate: the rotation is
 * baked into the model's geometry and the placement offset is applied on top of
 * those vertices. So a pivot taken off the model where it currently sits — its
 * bounds centre, a picked point — is wrong by exactly that offset, and the model
 * would swing about a point the user did not choose. Rotating and then moving is
 * not the same arrangement as moving and then rotating.
 */
export function pivotInModelFrame(placedPoint: Translation, translation: Translation): Translation {
  return subtractTranslation(placedPoint, translation);
}

/**
 * Rotate a workspace point about the vertical axis through `pivot`.
 *
 * Engineering axes: X/Y are the horizontal pair, Z is elevation and passes
 * through untouched. Positive `angle` turns X toward Y — counter-clockwise seen
 * from above.
 */
export function rotateWorkspacePoint(point: Translation, rotation: ModelRotation): Translation {
  if (rotation.angle === 0) return point;
  const cos = Math.cos(rotation.angle), sin = Math.sin(rotation.angle);
  const dx = point[0] - rotation.pivot[0], dy = point[1] - rotation.pivot[1];
  return [rotation.pivot[0] + dx * cos - dy * sin, rotation.pivot[1] + dx * sin + dy * cos, point[2]];
}
