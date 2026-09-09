/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { projectTo2D, projectTo2DBasis, type Drawing2D, type Point2D, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
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
  const points = [project(corners[0]), project(corners[1]), project(corners[2]), project(corners[3])] as const;
  const [a,b,,d] = points;
  const area = (b.x-a.x)*(d.y-a.y)-(b.y-a.y)*(d.x-a.x);
  return Number.isFinite(area) && Math.abs(area) > 1e-12 ? points : null;
}

export function drawingWithReferenceBounds(drawing: Drawing2D, references: readonly DrawingReferenceImage['corners'][]): Drawing2D {
  if (!references.length) return drawing;
  const hasGeometry = drawing.lines.length > 0 || drawing.cutPolygons.length > 0 || drawing.projectionPolygons.length > 0;
  const bounds = hasGeometry ? {min:{...drawing.bounds.min},max:{...drawing.bounds.max}}
    : {min:{x:Infinity,y:Infinity},max:{x:-Infinity,y:-Infinity}};
  for (const corners of references) for (const point of corners) {
    bounds.min.x=Math.min(bounds.min.x,point.x); bounds.min.y=Math.min(bounds.min.y,point.y);
    bounds.max.x=Math.max(bounds.max.x,point.x); bounds.max.y=Math.max(bounds.max.y,point.y);
  }
  return { ...drawing, bounds };
}
