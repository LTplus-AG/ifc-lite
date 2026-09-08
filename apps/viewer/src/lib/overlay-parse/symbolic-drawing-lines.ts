/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flat primitive stream → 2D-drawing lines (#2183).
 *
 * The 2D drawing's sibling of `buildParseResult` (`symbolic-parse.ts`): the
 * main-thread half that turns the worker's transferable arrays into renderable
 * geometry. It exists because the drawing used to walk the WASM
 * `SymbolicRepresentationCollection` inline in `useDrawingGeneration`, which
 * grew a ~470 MB main-thread `WebAssembly.Memory` the first time a user
 * generated a drawing — undoing, on that one code path, the whole point of
 * moving the parse into a worker.
 *
 * Unlike the overlay's assembly this keeps EVERY owner type (the flatten is
 * asked for `mode: 'all'`): a plan drawing draws the symbolic representation of
 * walls, doors and furniture, not just annotations and grid axes.
 *
 * This is a transcription, not a redesign. Segment order, the closing-segment
 * rule, the centroid arithmetic, the arc tessellation counts, and which express
 * ids land in `entities` are all exactly what the inline walk did.
 */

import type { DrawingLine } from '@ifc-lite/drawing-2d';
import type { FlatSymbolic } from './symbolic-flat.js';

/**
 * A drawing line carrying its parent primitive's world-space centroid.
 *
 * `@ifc-lite/drawing-2d`'s `DrawingLine` has no per-line position slot, and the
 * 2D Section filter needs one to cull symbolic primitives against the active
 * cut plane. Extra fields are ignored by the canvas, so this stays local.
 *
 * Coordinate space matches the section cutter's input (shifted bounds):
 * - `worldX`: the polyline's 2D x (already RTC-shifted by WASM)
 * - `worldZ`: −(2D y) — WASM negates Z into the 2D y axis to match section-cut
 *   output handedness, so flip it back
 * - `worldY`: the primitive's `worldY` (vertical elevation)
 */
export type SymbolicDrawingLine = DrawingLine & {
  worldX?: number;
  worldY?: number;
  worldZ?: number;
};

export interface SymbolicDrawingGeometry {
  /** Tessellated segments, polylines first then circles, in source order. */
  lines: SymbolicDrawingLine[];
  /** Every express id that carried a symbolic primitive, tessellated or not. */
  entities: Set<number>;
}

/** Arc tessellation, unchanged from the inline walk. */
const FULL_CIRCLE_SEGMENTS = 32;
const ARC_SEGMENTS = 16;

/**
 * A non-finite elevation means "unknown", not "at NaN".
 *
 * The inline walk read `worldY` defensively (`(poly as { worldY?: number })`)
 * so an older wasm bundle without the accessor yielded `undefined`, and the
 * section cull keeps a line whose centroid it cannot resolve — over-rendering
 * beats silently dropping authored geometry. Crossing the worker boundary the
 * absent value arrives as `NaN` in a `Float32Array`, so restore the sentinel
 * here; a degenerate placement gets the same benefit of the doubt.
 */
function elevationOrUnknown(worldY: number): number | undefined {
  return Number.isFinite(worldY) ? worldY : undefined;
}

/**
 * Build the drawing's symbolic lines from a `'all'`-mode flatten.
 *
 * `modelIndex` is stamped on every line; the drawing path is single-model for
 * now (federated symbolic parsing would parse each model separately), which is
 * why it defaults to 0.
 */
export function buildSymbolicDrawingLines(
  flat: FlatSymbolic,
  modelIndex = 0,
): SymbolicDrawingGeometry {
  const lines: SymbolicDrawingLine[] = [];
  const entities = new Set<number>();
  const typeNames = flat.typeNames;

  for (let i = 0; i < flat.polyOwner.length; i++) {
    const expressId = flat.polyOwner[i];
    const ifcType = typeNames[flat.polyType[i]];
    entities.add(expressId);

    // The points are consumed synchronously (centroid sum + segment pushes read
    // scalars out of them) and never stored, so a view over the shared buffer
    // is enough — no copy needed.
    const start = flat.polyStart[i];
    const pointCount = flat.polyStart[i + 1] - start;
    const points = flat.polyPoints.subarray(start * 2, (start + pointCount) * 2);
    const worldY = elevationOrUnknown(flat.polyWorldY[i]);

    // Centroid in shifted world coords, computed once per source polyline and
    // shared across its segments.
    let sumX = 0;
    let sumY = 0;
    for (let p = 0; p < pointCount; p++) {
      sumX += points[p * 2];
      sumY += points[p * 2 + 1];
    }
    const worldX = pointCount > 0 ? sumX / pointCount : undefined;
    const worldZ = pointCount > 0 ? -sumY / pointCount : undefined;

    for (let j = 0; j < pointCount - 1; j++) {
      lines.push({
        line: {
          start: { x: points[j * 2], y: points[j * 2 + 1] },
          end: { x: points[(j + 1) * 2], y: points[(j + 1) * 2 + 1] },
        },
        category: 'silhouette',
        visibility: 'visible',
        entityId: expressId,
        ifcType,
        modelIndex,
        depth: 0,
        worldX,
        worldY,
        worldZ,
      });
    }

    const isClosed = (flat.polyFlags[i] & 1) !== 0;
    if (isClosed && pointCount > 2) {
      lines.push({
        line: {
          start: { x: points[(pointCount - 1) * 2], y: points[(pointCount - 1) * 2 + 1] },
          end: { x: points[0], y: points[1] },
        },
        category: 'silhouette',
        visibility: 'visible',
        entityId: expressId,
        ifcType,
        modelIndex,
        depth: 0,
        worldX,
        worldY,
        worldZ,
      });
    }
  }

  for (let i = 0; i < flat.circleOwner.length; i++) {
    const expressId = flat.circleOwner[i];
    const ifcType = typeNames[flat.circleType[i]];
    entities.add(expressId);

    const isFullCircle = (flat.circleFlags[i] & 1) !== 0;
    const numSegments = isFullCircle ? FULL_CIRCLE_SEGMENTS : ARC_SEGMENTS;
    const centerX = flat.circleCenterX[i];
    const centerY = flat.circleCenterY[i];
    const radius = flat.circleRadius[i];
    const startAngle = flat.circleStartAngle[i];
    const endAngle = flat.circleEndAngle[i];
    const worldY = elevationOrUnknown(flat.circleWorldY[i]);
    // `centerX` is already RTC-shifted X; `centerY` carries the negated Z (see
    // the polyline note above) — flip to recover world Z.
    const worldX = centerX;
    const worldZ = -centerY;

    for (let j = 0; j < numSegments; j++) {
      const t1 = j / numSegments;
      const t2 = (j + 1) / numSegments;
      const a1 = startAngle + t1 * (endAngle - startAngle);
      const a2 = startAngle + t2 * (endAngle - startAngle);

      lines.push({
        line: {
          start: {
            x: centerX + radius * Math.cos(a1),
            y: centerY + radius * Math.sin(a1),
          },
          end: {
            x: centerX + radius * Math.cos(a2),
            y: centerY + radius * Math.sin(a2),
          },
        },
        category: 'silhouette',
        visibility: 'visible',
        entityId: expressId,
        ifcType,
        modelIndex,
        depth: 0,
        worldX,
        worldY,
        worldZ,
      });
    }
  }

  return { lines, entities };
}
