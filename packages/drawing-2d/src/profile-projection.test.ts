/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { ProfileEntry, SectionConfig } from './types.js';
import { Drawing2DGenerator } from './drawing-generator.js';
import { projectProfiles } from './profile-projector.js';

function createTransform(tx = 0, ty = 0, tz = 0): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ]);
}

function createProfile(overrides: Partial<ProfileEntry> = {}): ProfileEntry {
  return {
    expressId: 1,
    ifcType: 'IfcWall',
    outerPoints: new Float32Array([
      0, 0,
      2, 0,
      2, 1,
      0, 1,
    ]),
    holeCounts: new Uint32Array(),
    holePoints: new Float32Array(),
    transform: createTransform(),
    extrusionDir: new Float32Array([0, 1, 0]),
    extrusionDepth: 3,
    modelIndex: 0,
    ...overrides,
  };
}

function createBoxMesh(expressId: number, minX: number, maxX: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcBeam',
    modelIndex: 0,
    positions: new Float32Array([
      minX, 0, 0,
      maxX, 0, 0,
      maxX, 1, 0,
      minX, 1, 0,
      minX, 0, 1,
      maxX, 0, 1,
      maxX, 1, 1,
      minX, 1, 1,
    ]),
    normals: new Float32Array(8 * 3),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3,
      3, 7, 4, 3, 4, 0,
    ]),
    color: [1, 1, 1, 1],
  };
}

const sectionConfig: SectionConfig = {
  plane: {
    axis: 'x',
    position: 1,
    flipped: false,
  },
  projectionDepth: 2,
  includeHiddenLines: false,
  creaseAngle: 30,
  scale: 100,
};

describe('profile projection integration', () => {
  it('keeps profiles whose transformed footprint overlaps the projection window', () => {
    const profile = createProfile({
      extrusionDir: new Float32Array([0, 0, 1]),
      extrusionDepth: 1,
    });

    const lines = projectProfiles([profile], sectionConfig.plane, sectionConfig.projectionDepth);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.entityId === profile.expressId)).toBe(true);
  });

  it('retains crease-edge projection fallback for entities without extracted profiles', async () => {
    const generator = new Drawing2DGenerator();
    const profile = createProfile({ expressId: 10 });
    const mesh = createBoxMesh(20, 1.2, 1.8);

    const drawing = await generator.generate(
      [mesh],
      sectionConfig,
      {
        useGPU: false,
        includeHiddenLines: false,
        includeProjection: true,
        includeEdges: true,
        mergeLines: false,
      },
      [profile],
    );

    const projectionIds = drawing.lines
      .filter((line) => line.category === 'projection')
      .map((line) => line.entityId);

    expect(projectionIds).toContain(10);
    expect(projectionIds).toContain(20);
  });
});
