/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box's caps (#8696, phase 2 of #1329): one cap per box face.
 *
 * Each face is an axis-aligned cutting plane whose cap is held like the extra
 * planes' caps (#7545), under the key {@link sectionBoxCapKey}. The consumer
 * cuts the model on each face and uploads the polygons under that key; the
 * renderer draws each face's cap clipped by the four faces around it, so the
 * model-wide cut is trimmed to the face's rectangle. The opposite face is
 * parallel and never reaches the cap, and a face never clips its own cap.
 */

import type { ClipBox, ExtraClipPlane } from './clip-types.js';
import type { ExtraCapDraw } from './section-cap-set.js';

export type SectionBoxCapFace = 'minX' | 'maxX' | 'minY' | 'maxY' | 'minZ' | 'maxZ';

export const SECTION_BOX_CAP_FACES: readonly SectionBoxCapFace[] = ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'];

/** The cap key a box face's polygons are uploaded and drawn under. */
export function sectionBoxCapKey(face: SectionBoxCapFace): string {
  return `section-box:${face}`;
}

function faceAxis(face: SectionBoxCapFace): 0 | 1 | 2 {
  return face.endsWith('X') ? 0 : face.endsWith('Y') ? 1 : 2;
}

/**
 * The box's faces as clip planes, keyed by their cap key. Each removes the outside of its face,
 * exactly as the box clip does: the outward normal, `flipped` false.
 */
export function sectionBoxClipPlanes(box: Pick<ClipBox, 'min' | 'max'>): ExtraClipPlane[] {
  return SECTION_BOX_CAP_FACES.map((face) => {
    const axis = faceAxis(face);
    const max = face.startsWith('max');
    const normal: [number, number, number] = [0, 0, 0];
    normal[axis] = max ? 1 : -1;
    return { id: sectionBoxCapKey(face), normal, distance: max ? box.max[axis] : -box.min[axis], flipped: false };
  });
}

/**
 * One draw per box face: clipped by the four faces around it, then by `others` (the cutting planes),
 * so a face's cap never draws where another cut removed the model.
 */
export function sectionBoxCapDraws(box: Pick<ClipBox, 'min' | 'max'>, others: readonly ExtraClipPlane[]): ExtraCapDraw[] {
  const faces = sectionBoxClipPlanes(box);
  return SECTION_BOX_CAP_FACES.map((face, i) => ({
    key: faces[i]!.id!,
    clippedBy: [...faces.filter((_, j) => faceAxis(SECTION_BOX_CAP_FACES[j]!) !== faceAxis(face)), ...others],
  }));
}
