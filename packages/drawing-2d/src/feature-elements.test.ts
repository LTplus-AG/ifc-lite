/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import type { ProfileEntry, SectionConfig } from './types.js';
import { Drawing2DGenerator } from './drawing-generator.js';
import { isFeatureElementType } from './feature-elements.js';

describe('isFeatureElementType', () => {
  it('flags the IfcFeatureElement / void family', () => {
    for (const t of [
      'IfcOpeningElement',
      'IfcOpeningStandardCase',
      'IfcVoidingFeature',
      'IfcEarthworksCut',
      'IfcProjectionElement',
      'IfcSurfaceFeature',
      'IfcFeatureElementSubtraction',
      'IfcFeatureElementAddition',
      'IfcFeatureElement',
    ]) {
      expect(isFeatureElementType(t)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isFeatureElementType('IFCOPENINGELEMENT')).toBe(true);
    expect(isFeatureElementType('ifcopeningelement')).toBe(true);
  });

  it('does NOT flag real building structure (incl. doors/windows in the void)', () => {
    for (const t of ['IfcWall', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcDoor', 'IfcWindow', 'IfcRoof']) {
      expect(isFeatureElementType(t)).toBe(false);
    }
  });

  it('treats missing/empty type as non-feature', () => {
    expect(isFeatureElementType(undefined)).toBe(false);
    expect(isFeatureElementType(null)).toBe(false);
    expect(isFeatureElementType('')).toBe(false);
  });
});

// ─── Integration: openings must not project via EITHER path ───────────────────

function createTransform(tx = 0, ty = 0, tz = 0): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]);
}

function createProfile(expressId: number, ifcType: string): ProfileEntry {
  return {
    expressId,
    ifcType,
    outerPoints: new Float32Array([0, 0, 2, 0, 2, 1, 0, 1]),
    holeCounts: new Uint32Array(),
    holePoints: new Float32Array(),
    transform: createTransform(),
    extrusionDir: new Float32Array([0, 0, 1]),
    extrusionDepth: 1,
    modelIndex: 0,
  };
}

function createBoxMesh(expressId: number, ifcType: string, minX: number, maxX: number): MeshData {
  return {
    expressId,
    ifcType,
    modelIndex: 0,
    positions: new Float32Array([
      minX, 0, 0, maxX, 0, 0, maxX, 1, 0, minX, 1, 0,
      minX, 0, 1, maxX, 0, 1, maxX, 1, 1, minX, 1, 1,
    ]),
    normals: new Float32Array(8 * 3),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
    ]),
    color: [1, 1, 1, 1],
  };
}

const sectionConfig: SectionConfig = {
  plane: { axis: 'x', position: 1, flipped: false },
  projectionDepth: 2,
  includeHiddenLines: false,
  creaseAngle: 30,
  scale: 100,
};

describe('feature-element projection exclusion (issue #979)', () => {
  it('excludes opening profiles AND opening meshes from projection', async () => {
    const generator = new Drawing2DGenerator();

    // Real wall: present as a profile (clean path) — should project.
    const wallProfile = createProfile(10, 'IfcWall');
    // Opening present BOTH as a profile (stale-wasm case) and as a standalone
    // mesh (the prepass always meshes openings) — must project via neither.
    const openingProfile = createProfile(20, 'IfcOpeningElement');
    const openingMesh = createBoxMesh(20, 'IfcOpeningElement', 1.2, 1.8);
    // A non-extruded element with no profile that DOES project via silhouette.
    const beamMesh = createBoxMesh(30, 'IfcBeam', 1.2, 1.8);

    const drawing = await generator.generate(
      [openingMesh, beamMesh],
      sectionConfig,
      {
        useGPU: false,
        includeHiddenLines: false,
        includeProjection: true,
        includeEdges: true,
        mergeLines: false,
      },
      [wallProfile, openingProfile],
    );

    const projectionIds = new Set(
      drawing.lines.filter((l) => l.category === 'projection').map((l) => l.entityId),
    );
    const openingLines = drawing.lines.filter((l) => l.ifcType === 'IfcOpeningElement');

    // The opening (#20) must not appear via the profile path or the silhouette path.
    expect(projectionIds.has(20)).toBe(false);
    expect(openingLines.length).toBe(0);
    // Real structure still projects.
    expect(projectionIds.has(10)).toBe(true); // wall profile
    expect(projectionIds.has(30)).toBe(true); // beam silhouette
  });
});
