/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Fit frames in a drawing (#8802): the building at the cut, not the
 * union of everything the drawing holds.
 *
 * With construction projection on, a plan also draws every element below the
 * cut, including small far-off objects such as a model's "origin" and
 * "geo-reference" markers. On the sample house those sit 2.4 m and about 28 m
 * from a 6 m plan, so fitting the union showed the house as an 80 px
 * thumbnail in a corner of the canvas.
 *
 * The rule: start from the cut polygons (what the plane actually cuts is the
 * subject of the drawing), then repeatedly add every element whose bounding
 * box lies within {@link FIT_NEIGHBOURHOOD_RATIO} of the current frame's
 * larger side, until nothing more joins. Content touching or overlapping the
 * frame always joins, so a slab under a cut column, the walls' footprints and
 * the furniture inside a room are framed. A detached object farther away than
 * a quarter of the building's size is not. Nothing is removed from the
 * drawing: an element outside the frame is still drawn and reachable by
 * zooming out.
 *
 * Visible references (raster and DXF underlays) always join, as the drawing
 * guide documents ("Visible compatible references expand Fit"). A drawing
 * with no cut polygons (a cut above the model top, a projection-only view)
 * keeps the previous rule and frames all of its content.
 */

import type { Drawing2D } from '@ifc-lite/drawing-2d';

export type DrawingBounds = Drawing2D['bounds'];

/** An element joins the frame when its gap to it is at most this share of the frame's larger side. */
export const FIT_NEIGHBOURHOOD_RATIO = 0.25;

/** Growth passes are bounded; each pass adds every element in reach, so real drawings settle in two or three. */
const MAX_GROWTH_PASSES = 16;

type Box = { minX: number; minY: number; maxX: number; maxY: number };

const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

function grow(box: Box, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
}

const isEmpty = (box: Box): boolean => !(box.minX <= box.maxX && box.minY <= box.maxY);

/** Euclidean distance between two boxes; 0 when they touch or overlap. */
function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function union(a: Box, b: Box): void {
  a.minX = Math.min(a.minX, b.minX);
  a.minY = Math.min(a.minY, b.minY);
  a.maxX = Math.max(a.maxX, b.maxX);
  a.maxY = Math.max(a.maxY, b.maxY);
}

/** The bounds Fit frames for `drawing`; `referenceBounds` are the visible references' extent, if any. */
export function drawingFitBounds(drawing: Drawing2D, referenceBounds: DrawingBounds | null = null): DrawingBounds {
  const cutPolygons = drawing.cutPolygons ?? [];
  if (cutPolygons.length === 0) return drawing.bounds;

  const frame = emptyBox();
  for (const p of cutPolygons) for (const pt of p.polygon.outer) grow(frame, pt.x, pt.y);
  if (isEmpty(frame)) return drawing.bounds;

  // One box per element, so a far-off marker drawn as many lines is judged as one object.
  const elements = new Map<string, Box>();
  const boxFor = (modelIndex: number | undefined, entityId: number | undefined, fallbackKey: string): Box => {
    const key = entityId === undefined ? fallbackKey : `${modelIndex ?? 0}:${entityId}`;
    let box = elements.get(key);
    if (!box) elements.set(key, box = emptyBox());
    return box;
  };
  (drawing.lines ?? []).forEach((l, i) => {
    const box = boxFor(l.modelIndex, l.entityId, `line:${i}`);
    grow(box, l.line.start.x, l.line.start.y);
    grow(box, l.line.end.x, l.line.end.y);
  });
  (drawing.projectionPolygons ?? []).forEach((p, i) => {
    const box = boxFor(p.modelIndex, p.entityId, `projection:${i}`);
    for (const pt of p.polygon.outer) grow(box, pt.x, pt.y);
  });

  let pending = [...elements.values()].filter((box) => !isEmpty(box));
  for (let pass = 0; pass < MAX_GROWTH_PASSES && pending.length > 0; pass++) {
    const reach = FIT_NEIGHBOURHOOD_RATIO * Math.max(frame.maxX - frame.minX, frame.maxY - frame.minY);
    const joined: Box[] = [];
    const rest: Box[] = [];
    for (const box of pending) (gap(box, frame) <= reach ? joined : rest).push(box);
    if (joined.length === 0) break;
    for (const box of joined) union(frame, box);
    pending = rest;
  }

  if (referenceBounds) {
    const { min, max } = referenceBounds;
    grow(frame, min.x, min.y);
    grow(frame, max.x, max.y);
  }
  return { min: { x: frame.minX, y: frame.minY }, max: { x: frame.maxX, y: frame.maxY } };
}
