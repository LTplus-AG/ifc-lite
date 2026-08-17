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
import { projectTo2D } from './math.js';
import type {
  DrawingLine,
  MeshOutline2D,
  ProfileEntry,
  SectionAxis,
  SectionConfig,
} from './types.js';

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

// -----------------------------------------------------------------------------
// Outline-provider basis agreement (PR #2644 review)
//
// The outlineProvider contract is CARDINAL-only: it receives (axis, flipped)
// and returns contours + axisMin/axisMax in cardinal projection space, like
// the Rust meshOutline2d binding it models. The depth raster, by contrast,
// honours the FULL plane config. These tests pin that generate() never mixes
// the two bases: on a cardinal plane the provider is used; on a custom plane
// it is bypassed for the plane-aware silhouette path.
// -----------------------------------------------------------------------------

/**
 * A faithful stand-in for the Rust `meshOutline2d` provider: the world-space
 * footprint bounding box of the mesh in cardinal `projectTo2D` space, with
 * `axisMin`/`axisMax` along the cardinal cut axis. The ring is INSET by 0.25
 * so provider-derived lines are distinguishable from silhouette-derived ones
 * (a box silhouette lands exactly on the footprint, the inset ring cannot).
 */
function makeCardinalOutlineProvider(): {
  calls: Array<{ expressId: number; axis: SectionAxis; flipped: boolean }>;
  provider: (mesh: MeshData, axis: SectionAxis, flipped: boolean) => MeshOutline2D | null;
} {
  const calls: Array<{ expressId: number; axis: SectionAxis; flipped: boolean }> = [];
  const provider = (mesh: MeshData, axis: SectionAxis, flipped: boolean): MeshOutline2D | null => {
    calls.push({ expressId: mesh.expressId, axis, flipped });
    const o = mesh.origin ?? [0, 0, 0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let axisMin = Infinity;
    let axisMax = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const world = {
        x: mesh.positions[i] + o[0],
        y: mesh.positions[i + 1] + o[1],
        z: mesh.positions[i + 2] + o[2],
      };
      const p = projectTo2D(world, axis, flipped);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      axisMin = Math.min(axisMin, world[axis]);
      axisMax = Math.max(axisMax, world[axis]);
    }
    const inset = 0.25;
    const x0 = minX + inset;
    const y0 = minY + inset;
    const x1 = maxX - inset;
    const y1 = maxY - inset;
    return {
      contours: [[x0, y0, x1, y0, x1, y1, x0, y1]],
      axisMin,
      axisMax,
    };
  };
  return { calls, provider };
}

const INSET_RING_COORDS = [0.25, 9.75];

describe('generate() outline provider basis agreement (PR #2644 review)', () => {
  it('cardinal plane: uses the outline provider and classifies its lines correctly', async () => {
    const config = sectionConfig({ axis: 'z', position: 0, flipped: false });
    const { calls, provider } = makeCardinalOutlineProvider();

    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate([farBox(), nearBox()], config, {
      ...GEN_OPTIONS,
      outlineProvider: provider,
    });

    // The provider must still be used on cardinal planes (capability pin:
    // the custom-plane bypass below must not disable it everywhere).
    expect(calls.map((c) => c.expressId).sort()).toEqual([1, 2]);
    expect(calls.every((c) => c.axis === 'z' && c.flipped === false)).toBe(true);

    const farLines = projectionLinesOf(drawing.lines, 1);
    const nearLines = projectionLinesOf(drawing.lines, 2);
    expect(farLines.length).toBeGreaterThan(0);
    expect(nearLines.length).toBeGreaterThan(0);

    // Provider output (the inset ring), not the silhouette (the exact
    // footprint), must be what reaches the drawing: every far-line endpoint
    // coordinate is an inset-ring value, which the silhouette path can never
    // produce for a box.
    for (const l of farLines) {
      for (const p of [l.line.start, l.line.end]) {
        expect(INSET_RING_COORDS).toContain(p.x);
        expect(INSET_RING_COORDS).toContain(p.y);
      }
    }

    // Same occlusion truth as Case A: the far footprint lies fully under the
    // near box, the near box is unoccluded.
    expect(farLines.every((l) => l.visibility === 'hidden')).toBe(true);
    expect(nearLines.every((l) => l.visibility === 'visible')).toBe(true);
  });

  it('custom plane: bypasses the cardinal-only provider so lines and raster share one basis', async () => {
    // Same geometry and same expected outcome as the cardinal case above,
    // but the plane carries a customPlane whose tangent basis is TRANSLATED
    // (origin x = 100): custom-basis 2D coordinates are (x - 100, y) while
    // the cardinal provider would emit (x, y). If generate() fed the
    // provider's cardinal-space contours to the classifier, they would be
    // sampled against a raster built in the custom basis 100 units away --
    // no occluder information there, so the far box would wrongly classify
    // VISIBLE. The provider must be bypassed in favour of the plane-aware
    // silhouette path, reproducing the cardinal occlusion outcome.
    const config = sectionConfig({
      axis: 'z',
      position: 0,
      flipped: false,
      customPlane: {
        normal: { x: 0, y: 0, z: 1 },
        distance: 0,
        origin: { x: 100, y: 0, z: 0 },
        tangent: { x: 1, y: 0, z: 0 },
        bitangent: { x: 0, y: 1, z: 0 },
      },
    });
    const { calls, provider } = makeCardinalOutlineProvider();

    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = await generator.generate([farBox(), nearBox()], config, {
      ...GEN_OPTIONS,
      outlineProvider: provider,
    });

    const farLines = projectionLinesOf(drawing.lines, 1);
    const nearLines = projectionLinesOf(drawing.lines, 2);
    expect(farLines.length).toBeGreaterThan(0);
    expect(nearLines.length).toBeGreaterThan(0);

    // Occlusion outcome must match the equivalent cardinal case (far box
    // hidden under the near box, near box visible) -- the whole point of
    // basis agreement.
    expect(farLines.every((l) => l.visibility === 'hidden')).toBe(true);
    expect(nearLines.every((l) => l.visibility === 'visible')).toBe(true);

    // Mechanism pin: the cardinal-only provider must not run at all on a
    // custom plane (its output cannot be expressed in the custom basis).
    expect(calls).toEqual([]);

    // And the lines must come from the silhouette path in the CUSTOM basis:
    // the far footprint x in [0, 10] world maps to [-100, -90] there.
    expect(farLines.every((l) => l.line.start.x <= -90 && l.line.end.x <= -90)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue #2682 — line work must survive a mesh that is not outward-wound
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The same mesh with every triangle's last two indices swapped: identical
 * positions and identical edges, every face wound INWARD.
 *
 * ifc-lite's winding is explicitly unreliable (`MeshData.indices`), so this is
 * a shape the generator really receives — not a synthetic curiosity.
 */
function reverseWinding(mesh: MeshData): MeshData {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    indices[t] = mesh.indices[t];
    indices[t + 1] = mesh.indices[t + 2];
    indices[t + 2] = mesh.indices[t + 1];
  }
  return { ...mesh, indices };
}

/** Order-independent identity of a drawing line: endpoints, band and depths. */
function lineIdentity(l: DrawingLine): string {
  const a = `${l.line.start.x.toFixed(6)},${l.line.start.y.toFixed(6)}`;
  const b = `${l.line.end.x.toFixed(6)},${l.line.end.y.toFixed(6)}`;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const depths = [l.depth ?? 0, l.depthEnd ?? l.depth ?? 0].map((d) => d.toFixed(6)).sort();
  return `${lo}|${hi}|${l.category}|${l.visibility}|${depths.join('~')}`;
}

/** Bounded projection bands, i.e. what a real floor plan uses. */
function bandedPlanConfig(position: number): SectionConfig {
  return {
    plane: { axis: 'y', position, flipped: false },
    projectionDepth: 3,
    projectionBelowDepth: 3,
    projectionAboveDepth: 3,
    includeHiddenLines: true,
    creaseAngle: 30,
    scale: 100,
  };
}

async function drawingFor(meshes: MeshData[], config: SectionConfig) {
  const generator = new Drawing2DGenerator();
  await generator.initialize();
  return generator.generate(meshes, config, GEN_OPTIONS);
}

describe('generate() line work on non-outward-wound meshes (issue #2682)', () => {
  // A tall element — a shaft/core wall spanning several storeys, world Y in
  // [0, 10] — cut in plan at Y = 9.5 with the usual 3 m projection bands.
  // Its NEAR rim (the top, Y = 10) is in band; its FAR rim (the base, Y = 0)
  // is 9.5 m away and the band drops it.
  const tallOutward = () => boxMesh(1, [0, 0, 0], [4, 10, 4]);

  it('draws the outline of an INWARD-wound element instead of a blank sheet', async () => {
    const config = bandedPlanConfig(9.5);

    const outward = await drawingFor([tallOutward()], config);
    const inward = await drawingFor([reverseWinding(tallOutward())], config);

    const outwardLines = projectionLinesOf(outward.lines, 1);
    const inwardLines = projectionLinesOf(inward.lines, 1);

    // The control: an outward-wound box gets its four outline lines.
    expect(outwardLines.length).toBe(4);

    // The defect: the inward-wound twin used to silhouette the FAR rim, which
    // the projection band culls, leaving ZERO projection lines. The winding
    // must not decide whether the element is drawn at all.
    expect(inwardLines.length).toBe(4);

    // Acceptance (issue #2682): same positions, reversed index order, SAME
    // line work — right down to the band and the hidden-line depths.
    expect(inwardLines.map(lineIdentity).sort()).toEqual(outwardLines.map(lineIdentity).sort());
  });

  it('keeps the whole drawing identical for the inward-wound twin of a multi-element scene', async () => {
    // Two boxes, one occluding the other, viewed with generous bands — the
    // uncut "3D view" shape the PDF export uses. Every line the generator can
    // emit (cut, projection, visibility, depth) must be winding-independent.
    const config = sectionConfig({ axis: 'z', position: 0, flipped: false });

    const outward = await drawingFor([farBox(), nearBox()], config);
    const inward = await drawingFor(
      [reverseWinding(farBox()), reverseWinding(nearBox())],
      config,
    );

    expect(outward.lines.length).toBeGreaterThan(0);
    expect(inward.lines.map(lineIdentity).sort()).toEqual(outward.lines.map(lineIdentity).sort());
    expect(inward.bounds).toEqual(outward.bounds);
  });
});
