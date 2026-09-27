/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box's arithmetic (#5513, charter #5478 §6): an axis-aligned
 * world-space box the renderer clips to (`RenderOptions.clipBox`), held in
 * the store as `sectionPlane.box`. Pure helpers so the slice, the bar and
 * the scene gizmo agree on one geometry: a box from a bounds object, one
 * face moved along its axis without crossing the opposite face, the six
 * face centres the handles sit on, and the corners of each face.
 */

import type { SectionBox, SectionBoxFace } from '@/store/types';

interface Vec3Like { x: number; y: number; z: number }
interface BoundsLike { min: Vec3Like; max: Vec3Like }

export type Vec3Tuple = [number, number, number];

/** A box can never be thinner than this along any axis (metres). */
export const MIN_SECTION_BOX_SIZE_M = 0.05;

export const SECTION_BOX_FACES: readonly SectionBoxFace[] = ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'];

/** Which corner (`min`/`max`) and which axis index (x=0, y=1, z=2) a face is. */
export function faceSide(face: SectionBoxFace): { corner: 'min' | 'max'; axis: 0 | 1 | 2 } {
  const corner = face.startsWith('min') ? 'min' : 'max';
  const axis = face.endsWith('X') ? 0 : face.endsWith('Y') ? 1 : 2;
  return { corner, axis };
}

/** `bounds` as a section box, or `null` when it is degenerate or non-finite. */
export function sectionBoxFromBounds(bounds: BoundsLike | null | undefined): SectionBox | null {
  if (!bounds) return null;
  const min: Vec3Tuple = [bounds.min.x, bounds.min.y, bounds.min.z];
  const max: Vec3Tuple = [bounds.max.x, bounds.max.y, bounds.max.z];
  if (![...min, ...max].every(Number.isFinite)) return null;
  if (min.some((v, i) => max[i] - v < MIN_SECTION_BOX_SIZE_M)) return null;
  return { min, max };
}

/**
 * `box` with `face` moved to `value` (world units along the face's axis).
 * The opposite face is a hard stop: a min face stops `MIN_SECTION_BOX_SIZE_M`
 * short of the max face and vice versa, so a drag can never invert the box.
 * A non-finite `value` returns `box` unchanged.
 */
export function moveSectionBoxFace(box: SectionBox, face: SectionBoxFace, value: number): SectionBox {
  if (!Number.isFinite(value)) return box;
  const { corner, axis } = faceSide(face);
  const min: Vec3Tuple = [...box.min];
  const max: Vec3Tuple = [...box.max];
  if (corner === 'min') min[axis] = Math.min(value, max[axis] - MIN_SECTION_BOX_SIZE_M);
  else max[axis] = Math.max(value, min[axis] + MIN_SECTION_BOX_SIZE_M);
  return { min, max };
}

/** The box's extent along x, y, z (metres). */
export function sectionBoxSize(box: SectionBox): Vec3Tuple {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

/** The centre of `face`: the box centre with the face's axis coordinate on that side. */
export function sectionBoxFaceCenter(box: SectionBox, face: SectionBoxFace): Vec3Tuple {
  const { corner, axis } = faceSide(face);
  const c: Vec3Tuple = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  c[axis] = box[corner][axis];
  return c;
}

/** The unit outward normal of `face`. */
export function sectionBoxFaceNormal(face: SectionBoxFace): Vec3Tuple {
  const { corner, axis } = faceSide(face);
  const n: Vec3Tuple = [0, 0, 0];
  n[axis] = corner === 'min' ? -1 : 1;
  return n;
}

/** The four corners of `face`, in winding order. */
export function sectionBoxFaceCorners(box: SectionBox, face: SectionBoxFace): Vec3Tuple[] {
  const { corner, axis } = faceSide(face);
  const fixed = box[corner][axis];
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const at = (uv: 'min' | 'max', vv: 'min' | 'max'): Vec3Tuple => {
    const p: Vec3Tuple = [0, 0, 0];
    p[axis] = fixed;
    p[u] = box[uv][u];
    p[v] = box[vv][v];
    return p;
  };
  return [at('min', 'min'), at('max', 'min'), at('max', 'max'), at('min', 'max')];
}
