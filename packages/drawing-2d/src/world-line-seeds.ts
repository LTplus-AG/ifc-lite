/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Project world-space 3D segments (the section rim produced by
 * `half-space-clip.ts`) into classified `DrawingLine`s (issue #2042).
 *
 * # Defect class this module guards against
 * **A line producer that invents its own projection or its own depth
 * convention.** Everything else in this pipeline — the section cutter, the
 * edge extractor, the projection bands, and the hidden-line depth raster —
 * derives 2D coordinates from `projectPointForPlane` and view depths from
 * `−signedDepth`. A producer that re-implements either (a hand-rolled dot
 * product, a forgotten sign, a `depth` measured from the wrong side) emits
 * lines that look right on their own but sit in a *different frame* from the
 * depth buffer they are sampled against — so hidden-line removal silently
 * dashes visible edges, or leaves occluded ones solid, with no error
 * anywhere. This module does nothing but call those two shared helpers.
 *
 * The rim of a section cut is, by definition, geometry lying IN the cut
 * plane, so it is emitted as `category: 'cut'` (heavy line weight). It is
 * still handed to the hidden-line stage rather than drawn unconditionally:
 * on an oblique 3D view the far side of a cut object is genuinely behind
 * other geometry and must print dashed.
 */

import type { DrawingLine, Point2D, SectionPlaneConfig, Vec3 } from './types.js';
import { EPSILON, point2DDistance } from './math.js';
import { projectPointForPlane, signedDepth } from './projection-bands.js';

/** A world-space segment to be drawn, with its source element metadata. */
export interface WorldLineSeed {
  start: Vec3;
  end: Vec3;
  entityId: number;
  ifcType: string;
  modelIndex: number;
}

/**
 * Project `seeds` into drawing lines against `plane`.
 *
 * Segments whose 2D projection collapses to a point (an edge parallel to the
 * view direction) are dropped: they carry no information on the page and
 * would only add zero-length strokes for the line merger and the PDF writer
 * to trip over.
 */
export function projectWorldLineSeeds(
  seeds: readonly WorldLineSeed[],
  plane: SectionPlaneConfig,
): DrawingLine[] {
  const lines: DrawingLine[] = [];

  for (const seed of seeds) {
    const start: Point2D = projectPointForPlane(seed.start, plane);
    const end: Point2D = projectPointForPlane(seed.end, plane);
    if (point2DDistance(start, end) < EPSILON) continue;

    // VIEW depth (issue #2639): the negated flip-adjusted signed depth — 0 at
    // the plane, growing into the kept half, smaller means nearer the viewer.
    // Identical quantity to the one `buildDepthRaster` stores per pixel.
    const depth = -signedDepth(seed.start, plane);
    const depthEnd = -signedDepth(seed.end, plane);

    const line: DrawingLine = {
      line: { start, end },
      category: 'cut',
      visibility: 'visible',
      entityId: seed.entityId,
      ifcType: seed.ifcType,
      modelIndex: seed.modelIndex,
      depth,
    };
    // "Omitted means constant depth" — only carry `depthEnd` when it differs,
    // matching what every other producer in this package emits.
    if (depthEnd !== depth) line.depthEnd = depthEnd;
    lines.push(line);
  }

  return lines;
}
