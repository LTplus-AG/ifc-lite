/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { SectionPlaneConfig, ProfileEntry } from './types.js';
import {
  classifyDepthRange,
  classifySegmentBand,
  signedDepth,
  bandVisibility,
  getViewDirectionForPlane,
} from './projection-bands.js';
import { projectProfiles } from './profile-projector.js';
import { EdgeExtractor } from './edge-extractor.js';

// Plan / floor-plan section: cut horizontally at world-Y = 1 (geometric axis 'y').
const planPlane: SectionPlaneConfig = { axis: 'y', position: 1, flipped: false };
const planPlaneFlipped: SectionPlaneConfig = { axis: 'y', position: 1, flipped: true };

describe('classifyDepthRange', () => {
  const bands = { below: 3, above: 3 };

  it('classifies a range entirely below the cut as visible (solid)', () => {
    // d < 0 == below the cut, toward the floor
    expect(classifyDepthRange(-2, -0.5, bands)).toBe('visible');
  });

  it('classifies a range entirely above the cut as overhead (dashed)', () => {
    expect(classifyDepthRange(0.5, 2, bands)).toBe('overhead');
  });

  it('classifies a range straddling the cut as spanning (drawn solid)', () => {
    expect(classifyDepthRange(-1, 1, bands)).toBe('spanning');
  });

  it('culls a range beyond the below band', () => {
    expect(classifyDepthRange(-10, -5, bands)).toBe('cull');
  });

  it('culls a range beyond the above band', () => {
    expect(classifyDepthRange(5, 10, bands)).toBe('cull');
  });

  it('tolerates swapped min/max', () => {
    expect(classifyDepthRange(-0.5, -2, bands)).toBe('visible');
  });
});

describe('signedDepth sign convention (plan axis y)', () => {
  it('is negative below the cut, positive above (not flipped)', () => {
    expect(signedDepth({ x: 0, y: 0.2, z: 0 }, planPlane)).toBeLessThan(0); // below
    expect(signedDepth({ x: 0, y: 2.5, z: 0 }, planPlane)).toBeGreaterThan(0); // above
  });

  it('inverts when the section is flipped', () => {
    expect(signedDepth({ x: 0, y: 0.2, z: 0 }, planPlaneFlipped)).toBeGreaterThan(0);
    expect(signedDepth({ x: 0, y: 2.5, z: 0 }, planPlaneFlipped)).toBeLessThan(0);
  });
});

describe('classifySegmentBand', () => {
  const bands = { below: 5, above: 5 };

  it('maps a below-cut segment to visible and an above-cut segment to overhead', () => {
    const below = classifySegmentBand({ x: 0, y: 0.1, z: 0 }, { x: 1, y: 0.3, z: 0 }, planPlane, bands);
    const above = classifySegmentBand({ x: 0, y: 2.0, z: 0 }, { x: 1, y: 2.4, z: 0 }, planPlane, bands);
    expect(below).toBe('visible');
    expect(above).toBe('overhead');
    expect(bandVisibility(below)).toBe('visible');
    expect(bandVisibility(above)).toBe('hidden');
  });

  it('swaps which side is visible when flipped', () => {
    const below = classifySegmentBand({ x: 0, y: 0.1, z: 0 }, { x: 1, y: 0.3, z: 0 }, planPlaneFlipped, bands);
    const above = classifySegmentBand({ x: 0, y: 2.0, z: 0 }, { x: 1, y: 2.4, z: 0 }, planPlaneFlipped, bands);
    expect(below).toBe('overhead'); // now the +normal/overhead side
    expect(above).toBe('visible');
  });
});

describe('getViewDirectionForPlane', () => {
  it('looks down -Y for a non-flipped plan section', () => {
    expect(getViewDirectionForPlane(planPlane)).toEqual({ x: 0, y: -1, z: 0 });
  });
  it('looks up +Y when flipped', () => {
    expect(getViewDirectionForPlane(planPlaneFlipped)).toEqual({ x: 0, y: 1, z: 0 });
  });
});

// ── Profile band tagging end-to-end ─────────────────────────────────────────

function identityTransform(ty = 0): Float32Array {
  // column-major; ty places the profile base at world-Y = ty
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, ty, 0, 1]);
}

// A horizontal slab footprint in the XZ plane (profile X/Y → world X/Z would
// need a rotation; for band tests we only care about world-Y, so place the
// profile flat and extrude a tiny amount in +Y).
function slabProfile(expressId: number, baseY: number): ProfileEntry {
  return {
    expressId,
    ifcType: 'IfcSlab',
    outerPoints: new Float32Array([0, 0, 2, 0, 2, 2, 0, 2]),
    holeCounts: new Uint32Array(),
    holePoints: new Float32Array(),
    transform: identityTransform(baseY),
    extrusionDir: new Float32Array([0, 1, 0]),
    extrusionDepth: 0.2,
    modelIndex: 0,
  };
}

describe('projectProfiles band tagging', () => {
  it('tags a wholly-below profile visible and a wholly-overhead profile hidden', () => {
    // base at Y=0.0..0.2 → below cut(1); base at Y=2.0..2.2 → above cut(1)
    const belowProfile = slabProfile(1, 0);
    const overheadProfile = slabProfile(2, 2);

    const lines = projectProfiles([belowProfile, overheadProfile], planPlane, { below: 3, above: 3 });

    const below = lines.filter((l) => l.entityId === 1);
    const overhead = lines.filter((l) => l.entityId === 2);

    expect(below.length).toBeGreaterThan(0);
    expect(overhead.length).toBeGreaterThan(0);
    expect(below.every((l) => l.visibility === 'visible')).toBe(true);
    expect(overhead.every((l) => l.visibility === 'hidden')).toBe(true);
    expect(lines.every((l) => l.category === 'projection')).toBe(true);
  });

  it('culls a profile outside both bands', () => {
    const farAbove = slabProfile(3, 50);
    const lines = projectProfiles([farAbove], planPlane, { below: 3, above: 3 });
    expect(lines.length).toBe(0);
  });
});

// ── Plan-view silhouette footprint (the axis-aligned-box outline case) ───────

function boxMesh(expressId: number, y0: number, y1: number): MeshData {
  // Axis-aligned box spanning X[0,2] Y[y0,y1] Z[0,2].
  const positions = new Float32Array([
    0, y0, 0, 2, y0, 0, 2, y0, 2, 0, y0, 2, // bottom (y0)
    0, y1, 0, 2, y1, 0, 2, y1, 2, 0, y1, 2, // top (y1)
  ]);
  const indices = new Uint32Array([
    // bottom (−Y)
    0, 2, 1, 0, 3, 2,
    // top (+Y)
    4, 5, 6, 4, 6, 7,
    // sides
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return {
    expressId,
    ifcType: 'IfcRoof',
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [1, 1, 1, 1],
  };
}

describe('silhouette footprint under a downward plan view', () => {
  it('produces the footprint rectangle outline (>=4 edges) for an axis-aligned box', () => {
    const extractor = new EdgeExtractor(30);
    const mesh = boxMesh(40, 0, 0.5); // below the cut at Y=1
    const edges = extractor.extractEdgesFromMeshes([mesh]);
    const viewDir = getViewDirectionForPlane(planPlane); // (0,-1,0)
    const silhouettes = extractor.extractSilhouettes(edges, viewDir);
    const lines = extractor.edgesToProjectionLines(silhouettes, planPlane, { below: 3, above: 3 });

    // The footprint is a rectangle: at least the 4 outline edges, all visible
    // (the box is below the cut) and category 'projection'.
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.every((l) => l.category === 'projection')).toBe(true);
    expect(lines.every((l) => l.visibility === 'visible')).toBe(true);
    // Every projected line must be non-degenerate (real footprint, not points).
    expect(lines.every((l) => Math.hypot(l.line.end.x - l.line.start.x, l.line.end.y - l.line.start.y) > 1e-6)).toBe(true);
  });

  it('marks an overhead box dashed (overhead band)', () => {
    const extractor = new EdgeExtractor(30);
    const mesh = boxMesh(41, 2, 2.5); // above the cut at Y=1
    const edges = extractor.extractEdgesFromMeshes([mesh]);
    const silhouettes = extractor.extractSilhouettes(edges, getViewDirectionForPlane(planPlane));
    const lines = extractor.edgesToProjectionLines(silhouettes, planPlane, { below: 3, above: 3 });

    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.every((l) => l.visibility === 'hidden')).toBe(true);
  });
});
