/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, afterEach } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { generateFloorPlan } from './drawing-generator.js';
import { exportToSVG } from './svg-exporter.js';
import { HATCH_PATTERNS, type HatchPatternType } from './styles.js';

function box(expressId: number, ifcType: string, x: number): MeshData {
  const [x0, y0, z0, x1, y1, z1] = [x, 0, 0, x + 1, 3, 0.3];
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  return { expressId, ifcType, modelIndex: 0, positions, normals: new Float32Array(positions.length), indices, color: [1, 1, 1, 1] };
}

function undefinedPatternRefs(svg: string): string[] {
  const defined = new Set([...svg.matchAll(/<pattern id="([\w-]+)"/g)].map((m) => m[1]));
  const referenced = new Set([...svg.matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1]));
  return [...referenced].filter((id) => !defined.has(id));
}

const options = { useGPU: false, includeHiddenLines: false } as const;
const ALL_TYPES: HatchPatternType[] = [
  'solid', 'diagonal', 'cross-hatch', 'horizontal', 'vertical', 'brick',
  'concrete', 'insulation', 'earth', 'wood', 'steel', 'glass', 'none',
];
const registered: string[] = [];

afterEach(() => {
  for (const key of registered.splice(0)) delete HATCH_PATTERNS[key];
});

describe('every SVG hatch fill references a defined pattern (#10933)', () => {
  it('defines the cross-hatch a cut IfcRoof fills with', async () => {
    const svg = exportToSVG(await generateFloorPlan([box(1, 'IfcRoof', 0)], 1.2, options));
    expect(svg).toContain('url(#hatch-cross-hatch)');
    expect(undefinedPatternRefs(svg)).toEqual([]);
  });

  it('defines a pattern for every HatchPatternType a cut can be hatched with', async () => {
    const meshes = ALL_TYPES.map((type, i) => {
      const ifcType = `IfcTestHatch_${type}`;
      HATCH_PATTERNS[ifcType] = { type, spacing: 2, angle: 45, lineWeight: 0.13, strokeColor: '#000000' };
      registered.push(ifcType);
      return box(i + 1, ifcType, i * 2);
    });
    const svg = exportToSVG(await generateFloorPlan(meshes, 1.2, options));
    expect(undefinedPatternRefs(svg)).toEqual([]);
    for (const type of ['brick', 'insulation', 'earth', 'wood', 'vertical']) expect(svg).toContain(`url(#hatch-${type})`);
  });
});
