/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end generate() hidden-line-removal tests (issue #2639).
 *
 * These exercise the full pipeline (projection line production + depth
 * raster + classification) so a sign or half-space mismatch between the
 * line producers and the depth buffer cannot hide: a nearer, larger
 * element must HIDE a farther element it fully covers, and must itself
 * stay VISIBLE. The existence assertions keep the visibility assertions
 * from passing vacuously on an empty line set.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import type { DrawingLine, ProfileEntry, SectionConfig } from './types.js';

const GEN_OPTIONS = {
  useGPU: false,
  mergeLines: false,
  includeProjection: true,
  includeEdges: true,
  includeHiddenLines: true,
} as const;

/**
 * Axis-aligned box between world-space corners `min`/`max`, stored the way
 * MeshData stores geometry: positions in the element's LOCAL frame with an
 * optional per-element `origin` (world = origin + local). Wound outward so
 * the edge extractor's face normals are correct.
 */
function boxMesh(
  expressId: number,
  min: [number, number, number],
  max: [number, number, number],
  origin?: [number, number, number],
): MeshData {
  const o = origin ?? [0, 0, 0];
  const x0 = min[0] - o[0];
  const y0 = min[1] - o[1];
  const z0 = min[2] - o[2];
  const x1 = max[0] - o[0];
  const y1 = max[1] - o[1];
  const z1 = max[2] - o[2];
  const positions = new Float32Array([
    x0, y0, z0, // 0
    x1, y0, z0, // 1
    x1, y1, z0, // 2
    x0, y1, z0, // 3
    x0, y0, z1, // 4
    x1, y0, z1, // 5
    x1, y1, z1, // 6
    x0, y1, z1, // 7
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // z = z0 face, outward normal -z
    4, 5, 6, 4, 6, 7, // z = z1 face, outward normal +z
    0, 1, 5, 0, 5, 4, // y = y0 face, outward normal -y
    3, 7, 6, 3, 6, 2, // y = y1 face, outward normal +y
    0, 4, 7, 0, 7, 3, // x = x0 face, outward normal -x
    1, 2, 6, 1, 6, 5, // x = x1 face, outward normal +x
  ]);
  const mesh: MeshData = {
    expressId,
    ifcType: 'IfcWall',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [1, 1, 1, 1],
  };
  if (origin) mesh.origin = origin;
  return mesh;
}

function projectionLinesOf(lines: DrawingLine[], entityId: number): DrawingLine[] {
  return lines.filter((l) => l.category === 'projection' && l.entityId === entityId);
}

function sectionConfig(plane: SectionConfig['plane']): SectionConfig {
  return {
    plane,
    projectionDepth: 20,
    projectionBelowDepth: 20,
    // Keep the overhead band out of the way: these cases only exercise the
    // kept (visible) band below the cut.
    projectionAboveDepth: 0.001,
    includeHiddenLines: true,
    creaseAngle: 30,
    scale: 100,
  };
}

// Case A geometry (shared with Case C): plan view down the z axis, cut at
// z = 0. The far box (world z in [-11, -9]) sits fully inside the footprint
// of the strictly larger near box (world z in [-3, -1]). Non-zero origins
// keep the local-vs-world frame handling honest.
function farBox(): MeshData {
  return boxMesh(1, [0, 0, -11], [10, 10, -9], [5, 0, 0]);
}
function nearBox(): MeshData {
  return boxMesh(2, [-5, -5, -3], [15, 15, -1], [-2, 0, 0]);
}

describe('generate() hidden-line removal (issue #2639)', () => {
  it('Case A: hides a far box fully covered by a nearer, larger box (silhouette path, cardinal plane)', async () => {
    const config = sectionConfig({ axis: 'z', position: 0, flipped: false });

    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate([farBox(), nearBox()], config, GEN_OPTIONS);

    const farLines = projectionLinesOf(drawing.lines, 1);
    const nearLines = projectionLinesOf(drawing.lines, 2);

    // Existence first so the visibility assertions cannot pass vacuously.
    expect(farLines.length).toBeGreaterThan(0);
    expect(nearLines.length).toBeGreaterThan(0);

    // The far box top (world z = -9, view depth 9) lies behind the near box
    // (top z = -1, view depth 1) over its entire footprint.
    expect(farLines.every((l) => l.visibility === 'hidden')).toBe(true);

    // Anti-overcorrection guard: the near box is unoccluded and must stay
    // visible. A sign fix that leaves the occluder window in the cut-away
    // half yields an empty depth buffer whose NaN sampling path classifies
    // EVERYTHING hidden; this assertion catches exactly that.
    expect(nearLines.every((l) => l.visibility === 'visible')).toBe(true);
  });

  it('Case B: hides a far slab profile under a nearer covering slab (profile path, plan shape)', async () => {
    // Plan view down the y axis, cut at y = 10, above both slabs.
    // Near big slab just under the cut (y in [8, 9], view depth 1..2);
    // far small slab near the floor, drawn via a synthetic ProfileEntry.
    const nearSlab = boxMesh(2, [-5, 8, -5], [15, 9, 15]);
    const farSlabMesh = boxMesh(1, [0, 0, 1.5], [1, 2, 2.5]);
    const farProfile: ProfileEntry = {
      expressId: 1,
      ifcType: 'IfcSlab',
      // Unit square in local profile space.
      outerPoints: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      holeCounts: new Uint32Array(0),
      holePoints: new Float32Array(0),
      // Column-major, translation-only: local (x, y, 0) -> world (x, y, 2).
      transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1]),
      extrusionDir: new Float32Array([0, 1, 0]),
      extrusionDepth: 1,
      modelIndex: 0,
    };

    const config = sectionConfig({ axis: 'y', position: 10, flipped: false });

    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate(
      [nearSlab, farSlabMesh],
      config,
      GEN_OPTIONS,
      [farProfile],
    );

    const farLines = projectionLinesOf(drawing.lines, 1);
    const nearLines = projectionLinesOf(drawing.lines, 2);

    expect(farLines.length).toBeGreaterThan(0);
    expect(nearLines.length).toBeGreaterThan(0);

    // The far profile (world y in [0, 2], nearest-extent view depth >= 8)
    // lies under the near slab (top at y = 9, view depth 1): hidden.
    expect(farLines.every((l) => l.visibility === 'hidden')).toBe(true);

    // The near slab's own silhouette is unoccluded: visible.
    expect(nearLines.every((l) => l.visibility === 'visible')).toBe(true);
  });

  it('Case C: classifies against the custom plane basis, not the stale cardinal fields', async () => {
    // Same geometry and same expected outcome as Case A, but the plane is
    // expressed ONLY via customPlane (normal +z through the origin, with the
    // cutter's tangent/bitangent basis matching projectTo2D for z). The
    // cardinal fields are set deliberately WRONG (axis y, position 999):
    // classification must follow the custom basis, proving the depth buffer
    // is built from the full plane config rather than the cardinal fields.
    const config = sectionConfig({
      axis: 'y',
      position: 999,
      flipped: false,
      customPlane: {
        normal: { x: 0, y: 0, z: 1 },
        distance: 0,
        origin: { x: 0, y: 0, z: 0 },
        tangent: { x: 1, y: 0, z: 0 },
        bitangent: { x: 0, y: 1, z: 0 },
      },
    });

    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate([farBox(), nearBox()], config, GEN_OPTIONS);

    const farLines = projectionLinesOf(drawing.lines, 1);
    const nearLines = projectionLinesOf(drawing.lines, 2);

    expect(farLines.length).toBeGreaterThan(0);
    expect(nearLines.length).toBeGreaterThan(0);
    expect(farLines.every((l) => l.visibility === 'hidden')).toBe(true);
    expect(nearLines.every((l) => l.visibility === 'visible')).toBe(true);
  });
});
