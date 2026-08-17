/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World-space rim seeds -> drawing lines, and the `extraLines` generator
 * seam they feed (issue #2042).
 *
 * Defect class: a line producer that BYPASSES hidden-line classification.
 * `Drawing2DGenerator` deliberately passes `category: 'cut'` lines straight
 * through — cut lines from the section cutter lie IN the plane at view depth
 * 0 and can never be occluded. Rim lines from a CPU half-space clip carry
 * the same category but, on an oblique 3D view, sit at arbitrary depth and
 * CAN be occluded. If they took the pass-through path they would print solid
 * through a wall — the drawing equivalent of an X-ray, and completely
 * invisible in a screenshot of a simple test model.
 *
 * The load-bearing test is a pair of seeds with IDENTICAL 2D geometry and
 * different view depth against the same occluding slab: one must come out
 * `hidden`, the other `visible`. A seam that skipped classification, or a
 * depth convention that disagreed with the raster, fails one of the two.
 */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import { buildCameraSectionPlane, type WorldBounds3D } from './view-plane.js';
import { projectWorldLineSeeds, type WorldLineSeed } from './world-line-seeds.js';
import { signedDepth } from './projection-bands.js';
import { vec3 } from './math.js';
import type { DrawingLine, SectionConfig } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE: one occluding slab, viewed head-on from +Z
// ═══════════════════════════════════════════════════════════════════════════

function boxMesh(
  expressId: number,
  min: [number, number, number],
  max: [number, number, number],
): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  return {
    expressId,
    ifcType: 'IfcSlab',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2,
      0, 4, 7, 0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ]),
    color: [1, 1, 1, 1],
  };
}

/** Slab filling the middle of the view, close to the camera. */
const SLAB = boxMesh(1, [-2, -2, 0], [2, 2, 0.2]);

/** Everything drawn fits in here: the slab and both seed depths. */
const BOUNDS: WorldBounds3D = { min: vec3(-2, -2, -3), max: vec3(2, 2, 1) };

const CAMERA = { position: vec3(0, 0, 10), target: vec3(0, 0, 0), up: vec3(0, 1, 0) };

function seedAtZ(z: number): WorldLineSeed {
  return {
    start: vec3(-1, -1, z),
    end: vec3(1, 1, z),
    entityId: 99,
    ifcType: 'IfcWall',
    modelIndex: 0,
  };
}

function viewConfig(viewDepth: number, plane: SectionConfig['plane']): SectionConfig {
  return {
    plane,
    // "No cut": the whole model projects as solid behind a plane placed in
    // front of it (the band semantics `useDrawingGeneration` already uses).
    projectionDepth: viewDepth,
    projectionBelowDepth: viewDepth,
    projectionAboveDepth: 1e-3,
    includeHiddenLines: true,
    creaseAngle: 30,
    scale: 100,
  };
}

async function generateWithSeed(
  seedZ: number,
  includeHiddenLines: boolean,
): Promise<{ extraLines: DrawingLine[]; seedLines: DrawingLine[] }> {
  const { plane, viewDepth } = buildCameraSectionPlane(CAMERA, BOUNDS);
  const extraLines = projectWorldLineSeeds([seedAtZ(seedZ)], plane);
  const generator = new Drawing2DGenerator();
  await generator.initialize();
  try {
    const drawing = await generator.generate([SLAB], viewConfig(viewDepth, plane), {
      useGPU: false,
      includeHiddenLines,
      includeProjection: true,
      includeEdges: true,
      mergeLines: false,
      extraLines,
    });
    return { extraLines, seedLines: drawing.lines.filter((l) => l.entityId === 99) };
  } finally {
    generator.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('projectWorldLineSeeds', () => {
  const { plane } = buildCameraSectionPlane(CAMERA, BOUNDS);

  it('projects into the plane basis and carries the shared view-depth convention', () => {
    const seed = seedAtZ(-3);
    const [line] = projectWorldLineSeeds([seed], plane);

    // Camera looks down -Z with world up, so the drawing basis is world X/Y.
    expect(line.line.start.x).toBeCloseTo(-1, 9);
    expect(line.line.start.y).toBeCloseTo(-1, 9);
    expect(line.line.end.x).toBeCloseTo(1, 9);
    expect(line.line.end.y).toBeCloseTo(1, 9);

    expect(line.category).toBe('cut');
    expect(line.visibility).toBe('visible');
    expect(line.entityId).toBe(99);
    expect(line.ifcType).toBe('IfcWall');

    // Depth is exactly the negated flip-adjusted signed depth the raster uses.
    expect(line.depth).toBeCloseTo(-signedDepth(seed.start, plane), 12);
    // Both endpoints are at the same z, so no `depthEnd` is carried.
    expect(line.depthEnd).toBeUndefined();
  });

  it('carries depthEnd only for a segment whose endpoints differ in depth', () => {
    const sloped: WorldLineSeed = {
      start: vec3(-1, 0, -3),
      end: vec3(1, 0, 0),
      entityId: 5,
      ifcType: 'IfcBeam',
      modelIndex: 0,
    };
    const [line] = projectWorldLineSeeds([sloped], plane);
    expect(line.depthEnd).toBeDefined();
    // Stepping 3 m toward the viewer reduces the view depth by exactly 3 m.
    expect(line.depth - (line.depthEnd as number)).toBeCloseTo(3, 9);
  });

  it('drops a segment that projects to a point (parallel to the view direction)', () => {
    const alongView: WorldLineSeed = {
      start: vec3(0.5, 0.5, -3),
      end: vec3(0.5, 0.5, 0.5),
      entityId: 5,
      ifcType: 'IfcBeam',
      modelIndex: 0,
    };
    expect(projectWorldLineSeeds([alongView], plane)).toEqual([]);
    // ...but a segment that does project is kept, so the drop is selective.
    expect(projectWorldLineSeeds([seedAtZ(-3)], plane)).toHaveLength(1);
  });
});

describe('GeneratorOptions.extraLines goes THROUGH the hidden-line stage', () => {
  it('marks a seed behind the occluding slab as hidden', async () => {
    const { extraLines, seedLines } = await generateWithSeed(-3, true);

    // The seed entered the pipeline visible...
    expect(extraLines).toHaveLength(1);
    expect(extraLines[0].visibility).toBe('visible');

    // ...and came out classified hidden by the slab in front of it.
    expect(seedLines.length).toBeGreaterThan(0);
    for (const line of seedLines) {
      expect(line.category).toBe('cut');
      expect(line.visibility).toBe('hidden');
    }
  });

  it('leaves an otherwise identical seed IN FRONT of the slab visible', async () => {
    // Same 2D geometry, same category, only the view depth differs — so this
    // control fails if the seam simply hard-codes one outcome.
    const { seedLines } = await generateWithSeed(0.5, true);
    expect(seedLines.length).toBeGreaterThan(0);
    for (const line of seedLines) {
      expect(line.visibility).toBe('visible');
    }
  });

  it('still merges the seed in when hidden-line removal is switched off', async () => {
    const { seedLines } = await generateWithSeed(-3, false);
    expect(seedLines.length).toBeGreaterThan(0);
    for (const line of seedLines) {
      expect(line.visibility).toBe('visible');
    }
  });

  it('changes nothing when no extraLines are supplied', async () => {
    const { plane, viewDepth } = buildCameraSectionPlane(CAMERA, BOUNDS);
    const generator = new Drawing2DGenerator();
    await generator.initialize();
    try {
      const withOption = await generator.generate([SLAB], viewConfig(viewDepth, plane), {
        useGPU: false,
        includeHiddenLines: true,
        includeProjection: true,
        includeEdges: true,
        mergeLines: false,
        extraLines: [],
      });
      const withoutOption = await generator.generate([SLAB], viewConfig(viewDepth, plane), {
        useGPU: false,
        includeHiddenLines: true,
        includeProjection: true,
        includeEdges: true,
        mergeLines: false,
      });
      expect(withOption.lines.length).toBe(withoutOption.lines.length);
      expect(withOption.lines.filter((l) => l.entityId === 99)).toEqual([]);
    } finally {
      generator.dispose();
    }
  });
});
