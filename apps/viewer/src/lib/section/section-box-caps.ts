/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section box's faces as cutting planes, for their caps (#8696).
 *
 * Each face becomes a face-picked plane (`custom`) on the face, its normal
 * pointing out of the box, so the caps of the planes beyond the first (#7545)
 * carry it end to end unchanged: `capCutConfig` cuts it, `capSignature` keys
 * it, `capOverlayBasis` lifts it back. The cut is model-wide; the renderer
 * trims each face's cap to the face (`sectionBoxCapDraws`). A face's plane,
 * basis origin included, depends only on its own coordinate, so its signature
 * does too: dragging one face re-cuts that face alone.
 */

import { SECTION_BOX_CAP_FACES, planeBasis, sectionBoxCapKey } from '@ifc-lite/renderer';
import type { SectionBox, SectionPlane } from '@/store/types';
import { faceSide, sectionBoxFaceNormal } from './section-box';
import { boxHoldingPlane } from './section-render-clip';

/** A box face as the cap pipeline takes a plane: keyed by the renderer's cap key for the face. */
export type SectionBoxCapPlane = Pick<SectionPlane, 'id' | 'axis' | 'position' | 'flipped' | 'custom'>;

const AXIS: Record<0 | 1 | 2, SectionPlane['axis']> = { 0: 'side', 1: 'down', 2: 'front' };

export function sectionBoxCapPlanes(box: SectionBox): SectionBoxCapPlane[] {
  return SECTION_BOX_CAP_FACES.map((face) => {
    const normal = sectionBoxFaceNormal(face);
    const { corner, axis } = faceSide(face);
    const pickedAt: [number, number, number] = [0, 0, 0];
    pickedAt[axis] = box[corner][axis];
    const { tangent, bitangent } = planeBasis(normal);
    return {
      id: sectionBoxCapKey(face),
      axis: AXIS[axis],
      position: 0,
      flipped: false,
      custom: { normal, distance: pickedAt[axis] * normal[axis], pickedAt, tangent, bitangent },
    };
  });
}

/** The faces whose caps are drawn: those of the box that clips (`boxHoldingPlane`), while it cuts. */
export function cuttingSectionBoxCapPlanes(plane: SectionPlane, inactive: readonly SectionPlane[]): SectionBoxCapPlane[] {
  const boxed = boxHoldingPlane(plane, inactive);
  return boxed?.enabled && boxed.box ? sectionBoxCapPlanes(boxed.box) : [];
}
