/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a store `SectionPlane` becomes the cutter's `SectionConfig`, for the planes
 * whose cap is drawn without a Drawing panel (the cutting planes beyond the first,
 * #7545). The active plane's own drawing builds the same config inline in
 * `useDrawingGeneration`; `customCutPlane` is the one piece both share, so a
 * face-picked plane's basis is derived in exactly one place.
 */

import { createSectionConfig, type SectionConfig, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { SectionPlane } from '@/store/types';
import { customPlaneCenter } from '@/store/slices/section-plane-center';

/** Semantic (down/front/side) to geometric (x/y/z) axis, as the Drawing hook maps it. */
const AXIS: Record<SectionPlane['axis'], 'x' | 'y' | 'z'> = { down: 'y', front: 'z', side: 'x' };

type CustomPlane = NonNullable<SectionPlane['custom']>;

/**
 * The cutter's explicit plane for a face-picked one. The basis origin is the pick
 * point projected onto the LIVE plane (`customPlaneCenter`), not the pick point
 * itself: dragging only changes `distance`, and a basis origin off the plane makes
 * the cap's 2D-to-3D lift drop the normal component (the cap freezes at the pick).
 */
export function customCutPlane(c: CustomPlane): NonNullable<SectionPlaneConfig['customPlane']> {
  const origin = customPlaneCenter(c);
  return {
    normal:    { x: c.normal[0],    y: c.normal[1],    z: c.normal[2]    },
    distance:  c.distance,
    origin:    { x: origin[0],      y: origin[1],      z: origin[2]      },
    tangent:   { x: c.tangent[0],   y: c.tangent[1],   z: c.tangent[2]   },
    bitangent: { x: c.bitangent[0], y: c.bitangent[1], z: c.bitangent[2] },
  };
}

/** Bounds of the model in the frame the cut is made in (`coordinateInfo.shiftedBounds`). */
export interface CutBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * The plane-only cut of `plane` (no projection, no hidden lines): all a cap needs.
 * `null` when the model has no usable extent along the axis to place the slider in.
 */
export function capCutConfig(plane: Pick<SectionPlane, 'axis' | 'position' | 'flipped' | 'custom'>, bounds: CutBounds): SectionConfig | null {
  const axis = AXIS[plane.axis];
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const config = createSectionConfig(axis, min + (plane.position / 100) * (max - min), {
    projectionDepth: 0,
    includeHiddenLines: false,
  });
  config.plane.flipped = plane.flipped;
  if (plane.custom) config.plane.customPlane = customCutPlane(plane.custom);
  return config;
}

/** What identifies a cap's cut: equal signatures mean the same polygons for the same model state. */
export function capSignature(plane: Pick<SectionPlane, 'axis' | 'position' | 'flipped' | 'custom'>): string {
  const c = plane.custom;
  return JSON.stringify([plane.axis, plane.position, plane.flipped, c ? [c.normal, c.distance, c.pickedAt, c.tangent, c.bitangent] : null]);
}
