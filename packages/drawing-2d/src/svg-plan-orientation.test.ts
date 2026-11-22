/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator, createSectionConfig, generateFloorPlan } from './drawing-generator.js';
import { exportToSVG } from './svg-exporter.js';

type V3 = [number, number, number];

function box(expressId: number, ifcType: string, min: V3, max: V3): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
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

function hatchPathY(svg: string, entityId: number): number {
  const match = new RegExp(`<path d="M [-\\d.]+ ([-\\d.]+)[^"]*"[^>]*data-entity-id="${entityId}"`).exec(svg);
  if (!match) throw new Error(`no hatch path for entity ${entityId}`);
  return Number(match[1]);
}

const options = { useGPU: false, includeHiddenLines: false } as const;

describe('exportToSVG sheet orientation (#10930)', () => {
  it('draws a plan north-up: IFC +Y (render -Z) sits above IFC -Y on the sheet', async () => {
    const south = box(1, 'IfcWall', [0, 0, 0], [4, 3, 0.3]);
    const north = box(2, 'IfcWall', [0, 0, -10.3], [4, 3, -10]);
    const svg = exportToSVG(await generateFloorPlan([south, north], 1.2, options));
    expect(hatchPathY(svg, 2)).toBeLessThan(hatchPathY(svg, 1));
  });

  it('keeps model up at the top of a vertical section', async () => {
    const low = box(1, 'IfcSlab', [0, 0, 0], [4, 0.3, 4]);
    const high = box(2, 'IfcSlab', [0, 3, 0], [4, 3.3, 4]);
    const drawing = await new Drawing2DGenerator().generate([low, high], createSectionConfig('x', 2), options);
    const svg = exportToSVG(drawing);
    expect(hatchPathY(svg, 2)).toBeLessThan(hatchPathY(svg, 1));
  });
});
