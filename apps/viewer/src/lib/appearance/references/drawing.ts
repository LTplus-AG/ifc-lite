/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { projectTo2D, projectTo2DBasis, type Point2D, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { ViewerState } from '@/store';
import { referenceRenderCorners } from '../reference-runtime/frame';
import type { RegisteredAppearanceReference } from './types';

export interface DrawingReferenceImage {
  id: string;
  image: ImageBitmap;
  corners: readonly [Point2D, Point2D, Point2D, Point2D];
  opacity: number;
}

/** Use the exact renderer rebase and the section cutter's projection, once.
 * References are underlays, not section-cut geometry: elevation does not hide
 * a plan reference. Edge-on planes naturally have zero projected area. */
export function referenceDrawingCorners(record: RegisteredAppearanceReference, state: ViewerState,
  plane: SectionPlaneConfig): DrawingReferenceImage['corners'] | null {
  if (!record.visible || record.opacity <= 0) return null;
  const corners = referenceRenderCorners(record, state);
  if (!corners) return null;
  const project = (p: readonly [number, number, number]) => {
    const point = { x: p[0], y: p[1], z: p[2] }, custom = plane.customPlane;
    return custom ? projectTo2DBasis(point, custom.origin, custom.tangent, custom.bitangent)
      : projectTo2D(point, plane.axis, plane.flipped);
  };
  return [project(corners[0]), project(corners[1]), project(corners[2]), project(corners[3])];
}
