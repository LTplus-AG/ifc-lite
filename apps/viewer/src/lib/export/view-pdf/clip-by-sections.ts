/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cut the sheet's meshes by every cutting plane that is on (#7545): what the
 * screen keeps is the intersection of the planes' kept half-spaces, so the
 * meshes are clipped plane after plane. Each plane's rim (the heavy cut line) is
 * trimmed by the planes applied after it, so no cut line runs into a region
 * another plane removed.
 */

import { clipMeshesToHalfSpace, type WorldSegment } from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';
import { clipSegmentsToHalfSpace } from './clip-rim-segments';
import { resolveKeptHalfSpace, type ViewSectionResolveInput } from './view-section-plane';

export function clipMeshesBySections(
  meshes: MeshData[],
  cuts: readonly ViewSectionResolveInput[],
): { meshes: MeshData[]; rimSegments: WorldSegment[] } {
  let kept = meshes;
  let rimSegments: WorldSegment[] = [];
  for (const cut of cuts) {
    const half = resolveKeptHalfSpace(cut);
    rimSegments = clipSegmentsToHalfSpace(rimSegments, half.normal, half.offset);
    const clipped = clipMeshesToHalfSpace(kept, half.normal, half.offset);
    kept = clipped.meshes;
    for (const segment of clipped.rimSegments) rimSegments.push(segment);
    if (kept.length === 0) {
      throw new Error('Nothing to export: the section cut removes all visible geometry.');
    }
  }
  return { meshes: kept, rimSegments };
}
