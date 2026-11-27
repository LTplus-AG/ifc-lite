/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { occurrenceOrigin, type Template } from './scene-instance-materialization.js';
import { isEntityVisible } from './entity-visibility.js';
import { CandidateBuild, type PieceCandidates } from './snap-corner-candidates.js';
import { GeometryCacheBuild } from './snap-geometry-build.js';
import type { BuildContext } from './snap-corner-pipeline.js';
import type { CornerGrid } from './snap-corner-grid.js';

interface Occurrence {
  expressId: number;
  template: Template;
  location: { byteOffset: number; originalColor: [number, number, number, number] };
}
export type SnapOccurrences = () => Iterable<Occurrence | null>;

function* transform(points: Float64Array, matrix: Float32Array, origin: number[]) {
  const out = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    for (let axis = 0; axis < 3; axis++) {
      out[i + axis] = origin[axis] + matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z;
    }
    if ((i + 3) % 768 === 0) yield;
  }
  return out;
}

/** Discover topology once per template. Only feature coordinates are expanded per occurrence. */
export function* buildInstanceCorners(occurrences: Iterable<Occurrence | null>, ctx: BuildContext,
  grid: CornerGrid, templates: WeakMap<object, PieceCandidates>) {
  for (const occurrence of occurrences) {
    yield;
    if (!occurrence) continue;
    const { expressId, template, location } = occurrence;
    if (ctx.eligible && !ctx.eligible.has(template.modelIndex)) continue;
    if (!isEntityVisible(expressId, ctx.hiddenIds, ctx.isolatedIds)) continue;
    const piece: MeshData = { expressId, modelIndex: template.modelIndex, color: location.originalColor,
      positions: template.positions, normals: template.normals, indices: template.indices };
    let local = templates.get(template);
    if (!local) {
      const geometry = new GeometryCacheBuild(piece);
      while (!geometry.step()) yield;
      const build = new CandidateBuild(expressId, geometry.result());
      while (!build.step()) yield;
      local = build.result();
      templates.set(template, local);
    }
    const matrix = new Float32Array(template.instanceData, location.byteOffset, 16);
    const origin = occurrenceOrigin(template, location.byteOffset, new DataView(template.instanceData));
    const corners = yield* transform(local.corners, matrix, origin);
    const edges = yield* transform(local.edges, matrix, origin);
    const candidates = { expressId, corners, edges };
    while (!grid.addPieceStep(piece, candidates)) yield;
  }
}
