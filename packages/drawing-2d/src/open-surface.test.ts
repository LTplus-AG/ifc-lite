/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cutting a zero-thickness open shell yields lines, not filled area (#8664), and
 * every solid that merely looks open at some level keeps its fill.
 */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator, createSectionConfig } from './drawing-generator.js';
import { SectionCutter, cutMeshesStreaming } from './section-cutter.js';
import { OpenSurfaceIndex } from './open-surface.js';
import { polygonSignedArea } from './math.js';
import { makeEntityKey } from './types.js';
import type { Drawing2D } from './types.js';

type P = [number, number, number];
type Quad = [P, P, P, P];
const ID = 7;

/** Quads as triangles, every face with its OWN vertices, as faceted meshes arrive. */
function mesh(quads: Quad[], extra: Partial<MeshData> = {}): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const quad of quads) {
    const base = positions.length / 3;
    positions.push(...quad.flat());
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    expressId: ID,
    ifcType: 'IfcBuildingElementProxy',
    modelIndex: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
    color: [0.5, 0.5, 0.5, 1],
    ...extra,
  };
}

/** The six faces of a box spanning y in [0, 3], split so a caller can drop some. */
function boxFaces(x0: number, x1: number, z0: number, z1: number) {
  return {
    south: [[x0, 0, z0], [x1, 0, z0], [x1, 3, z0], [x0, 3, z0]] as Quad,
    north: [[x1, 0, z1], [x0, 0, z1], [x0, 3, z1], [x1, 3, z1]] as Quad,
    west: [[x0, 0, z1], [x0, 0, z0], [x0, 3, z0], [x0, 3, z1]] as Quad,
    east: [[x1, 0, z0], [x1, 0, z1], [x1, 3, z1], [x1, 3, z0]] as Quad,
    top: [[x0, 3, z0], [x1, 3, z0], [x1, 3, z1], [x0, 3, z1]] as Quad,
    bottom: [[x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]] as Quad,
  };
}

async function planCut(meshes: MeshData[], mergeLines = false): Promise<Drawing2D> {
  return new Drawing2DGenerator().generate(meshes, createSectionConfig('y', 1.5), {
    useGPU: false,
    mergeLines,
    includeProjection: false,
    includeEdges: false,
    includeHiddenLines: false,
  });
}

const flagged = (d: Drawing2D) => d.lines.filter((l) => l.openSurfaceCut);

describe('OpenSurfaceIndex', () => {
  const key = makeEntityKey(0, ID);

  it('reads a box with unshared face vertices as closed', () => {
    expect(new OpenSurfaceIndex([mesh(Object.values(boxFaces(0, 2, 0, 1)))]).has(key)).toBe(false);
  });

  it('reads a box with one face missing as open', () => {
    const { top: _top, ...open } = boxFaces(0, 2, 0, 1);
    expect(new OpenSurfaceIndex([mesh(Object.values(open))]).has(key)).toBe(true);
  });

  it('judges the whole entity: two open bands that union to a closed box are closed', () => {
    const left = boxFaces(0, 2, 0, 1);
    const right = boxFaces(2, 4, 0, 1);
    const band = (f: typeof left, side: 'west' | 'east') => {
      const { [side]: _interface, ...rest } = f;
      return Object.values(rest);
    };
    const bands = [mesh(band(left, 'east')), mesh(band(right, 'west'))];
    expect(new OpenSurfaceIndex([bands[0]]).has(key)).toBe(true);
    expect(new OpenSurfaceIndex(bands).has(key)).toBe(false);
  });

  it('welds in world space, across sub-meshes with different origins', () => {
    const f = boxFaces(0, 2, 0, 1);
    const shifted = (q: Quad): Quad => q.map(([x, y, z]) => [x - 100, y, z]) as Quad;
    const a = mesh([f.south, f.north, f.west, f.top, f.bottom]);
    const b = mesh([shifted(f.east)], { origin: [100, 0, 0] });
    expect(new OpenSurfaceIndex([a, b]).has(key)).toBe(false);
  });

  it('knows nothing open about an entity it has no mesh for', () => {
    expect(new OpenSurfaceIndex([]).has(key)).toBe(false);
  });
});

describe('section of an open surface (#8664)', () => {
  const vFold: Quad[] = [
    [[0, 0, 0], [2, 0, 1], [2, 3, 1], [0, 3, 0]],
    [[2, 0, 1], [4, 0, 0], [4, 3, 0], [2, 3, 1]],
  ];

  it('emits a folded sheet as lines, where it used to fill the triangle under its chord', async () => {
    const drawing = await planCut([mesh(vFold)]);
    expect(drawing.cutPolygons).toEqual([]);
    expect(flagged(drawing).length).toBeGreaterThan(0);
    expect(flagged(drawing).length).toBe(drawing.lines.length);
  });

  it('emits a lone flat sheet as a line instead of dropping it', async () => {
    const drawing = await planCut([mesh([vFold[0]])]);
    expect(drawing.cutPolygons).toEqual([]);
    expect(flagged(drawing).length).toBeGreaterThan(0);
  });

  it('does not fill a long hairpin, whose gap is small only beside its length', async () => {
    const hairpin: Quad[] = [
      [[0, 0, 0], [20, 0, 0], [20, 3, 0], [0, 3, 0]],
      [[20, 0, 0], [20, 0, 1], [20, 3, 1], [20, 3, 0]],
      [[20, 0, 1], [0, 0, 1], [0, 3, 1], [20, 3, 1]],
    ];
    const drawing = await planCut([mesh(hairpin)]);
    expect(drawing.cutPolygons).toEqual([]);
    expect(flagged(drawing).length).toBeGreaterThan(0);
  });

  it('keeps the flag through line merging, as one line per straight run', async () => {
    const drawing = await planCut([mesh(vFold)], true);
    expect(drawing.lines).toHaveLength(2);
    expect(flagged(drawing)).toHaveLength(2);
  });

  it('does not stitch a multi-coloured open shell into a fill', async () => {
    const red = mesh([vFold[0]], { color: [1, 0, 0, 1] });
    const blue = mesh([vFold[1]], { color: [0, 0, 1, 1] });
    const drawing = await planCut([red, blue]);
    expect(drawing.cutPolygons).toEqual([]);
    expect(drawing.layerBaseCutPolygons).toEqual([]);
    expect(flagged(drawing).length).toBeGreaterThan(0);
  });

  it('fills the closed loop and draws the open chain of a mixed entity', async () => {
    const solid = Object.values(boxFaces(0, 2, 0, 1));
    const sheet = vFold.map((q) => q.map(([x, y, z]) => [x + 10, y, z]) as Quad);
    const drawing = await planCut([mesh([...solid, ...sheet])]);
    expect(drawing.cutPolygons).toHaveLength(1);
    expect(flagged(drawing).length).toBeGreaterThan(0);
    expect(flagged(drawing).every((l) => Math.abs(l.line.start.x) >= 10)).toBe(true);
  });
});

describe('the public cutters report what they leave unfilled (#8664)', () => {
  const sheet: Quad = [[0, 0, 0], [2, 0, 1], [2, 3, 1], [0, 3, 0]];

  it('SectionCutter.cutMeshes', () => {
    const result = new SectionCutter({ axis: 'y', position: 1.5, flipped: false }).cutMeshes([mesh([sheet])]);
    expect(result.polygons).toEqual([]);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.openSurfaceSegments).toEqual(new Set(result.segments));
  });

  it('cutMeshesStreaming', async () => {
    const result = await cutMeshesStreaming([mesh([sheet])], { axis: 'y', position: 1.5, flipped: false });
    expect(result.polygons).toEqual([]);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.openSurfaceSegments).toEqual(new Set(result.segments));
  });
});

describe('solids keep their fill (#8664)', () => {
  it('fills a closed box and draws no flagged line', async () => {
    const drawing = await planCut([mesh(Object.values(boxFaces(0, 2, 0, 1)))]);
    expect(drawing.cutPolygons).toHaveLength(1);
    expect(flagged(drawing)).toEqual([]);
  });

  it('fills a solid whose only mesh hole is away from the cut', async () => {
    const { top: _top, ...open } = boxFaces(0, 2, 0, 1);
    const drawing = await planCut([mesh(Object.values(open))]);
    expect(drawing.cutPolygons).toHaveLength(1);
    expect(flagged(drawing)).toEqual([]);
  });

  it('closes a hairline crack in a solid instead of reading it as a sheet edge', async () => {
    const f = boxFaces(0, 2, 0, 1);
    // A 5 mm slit in the south face: a mesh defect against a 6 m outline.
    const left: Quad = [[0, 0, 0], [0.995, 0, 0], [0.995, 3, 0], [0, 3, 0]];
    const right: Quad = [[1, 0, 0], [2, 0, 0], [2, 3, 0], [1, 3, 0]];
    const drawing = await planCut([mesh([left, right, f.north, f.west, f.east, f.top, f.bottom])]);
    expect(drawing.cutPolygons).toHaveLength(1);
    expect(flagged(drawing)).toEqual([]);
  });

  it('closes an outline split by several cracks, each too small for the chain it sits on', async () => {
    const f = boxFaces(0, 2, 0, 1);
    const seam = (z: number, gap: number): Quad[] => [
      [[0, 0, z], [1 - gap, 0, z], [1 - gap, 3, z], [0, 3, z]],
      [[1 + gap, 0, z], [2, 0, z], [2, 3, z], [1 + gap, 3, z]],
    ];
    const drawing = await planCut([mesh([...seam(0, 0.0007), ...seam(1, 0.0007), f.west, f.east, f.top, f.bottom])]);
    // One polygon per half, each closed across its crack: what such a mesh always gave.
    expect(drawing.cutPolygons).toHaveLength(2);
    expect(flagged(drawing)).toEqual([]);
  });

  it('keeps layer colours when the same entity also carries an open sheet', async () => {
    const { east: _east, ...outer } = boxFaces(0, 2, 0, 1);
    const { west: _west, ...inner } = boxFaces(2, 4, 0, 1);
    const sheet: Quad = [[10, 0, 0], [12, 0, 1], [12, 3, 1], [10, 3, 0]];
    const drawing = await planCut([
      mesh([...Object.values(outer), sheet], { color: [1, 0, 0, 1] }),
      mesh(Object.values(inner), { color: [0, 0, 1, 1] }),
    ]);
    expect(drawing.cutPolygons.map((p) => p.color)).toEqual([[1, 0, 0, 1], [0, 0, 1, 1]]);
    expect(flagged(drawing).length).toBeGreaterThan(0);
  });

  it("does not paint a solid in a sheet's colour when the sheet's mesh comes first", async () => {
    const red: [number, number, number, number] = [1, 0, 0, 1];
    const sheet: Quad = [[10, 0, 0], [12, 0, 1], [12, 3, 1], [10, 3, 0]];
    const drawing = await planCut([
      mesh([sheet], { color: [0, 0, 1, 1] }),
      mesh(Object.values(boxFaces(0, 2, 0, 1)), { color: red }),
    ]);
    expect(drawing.cutPolygons).toHaveLength(1);
    expect(drawing.cutPolygons[0].sourceColor).toEqual(red);
  });

  describe('with a sheet welded to it, in either face order', () => {
    const box = Object.values(boxFaces(0, 2, 0, 1));
    const fins: Record<string, Quad> = {
      'running on from a corner': [[2, 0, 0], [3, 0, 0], [3, 3, 0], [2, 3, 0]],
      'off the middle of a face': [[1, 0, 0], [1, 0, -0.5], [1, 3, -0.5], [1, 3, 0]],
      'diagonally off a corner': [[0, 0, 0], [-1, 0, -1], [-1, 3, -1], [0, 3, 0]],
    };
    for (const [name, fin] of Object.entries(fins)) {
      for (const [order, quads] of [['fin first', [fin, ...box]], ['fin last', [...box, fin]]] as const) {
        it(`${name}, ${order}`, async () => {
          const drawing = await planCut([mesh([...quads])]);
          expect(drawing.cutPolygons).toHaveLength(1);
          expect(Math.abs(polygonSignedArea(drawing.cutPolygons[0].polygon.outer))).toBeCloseTo(2);
          expect(flagged(drawing).length).toBeGreaterThan(0);
        });
      }
    }
  });

  it('closes its crack rather than joining a sheet that ends beside it', async () => {
    const f = boxFaces(0, 2, 0, 1);
    const left: Quad = [[0, 0, 0], [0.999, 0, 0], [0.999, 3, 0], [0, 3, 0]];
    const right: Quad = [[1.001, 0, 0], [2, 0, 0], [2, 3, 0], [1.001, 3, 0]];
    const sheet: Quad = [[1, 0, -0.005], [1, 0, -0.5], [1, 3, -0.5], [1, 3, -0.005]];
    const solid = [left, right, f.north, f.west, f.east, f.top, f.bottom];
    for (const quads of [[...solid, sheet], [sheet, ...solid]]) {
      const drawing = await planCut([mesh(quads)]);
      expect(drawing.cutPolygons).toHaveLength(1);
      expect(flagged(drawing).length).toBeGreaterThan(0);
    }
  });

  it('fills a solid with a duplicated face, whose parity reads as free edges', async () => {
    const f = boxFaces(0, 2, 0, 1);
    const drawing = await planCut([mesh([...Object.values(f), f.south])]);
    expect(drawing.cutPolygons).toHaveLength(1);
    expect(flagged(drawing)).toEqual([]);
  });

  it('keeps per-layer fills on a layered wall, whose bands are open only one at a time', async () => {
    const { east: _east, ...outer } = boxFaces(0, 2, 0, 1);
    const { west: _west, ...inner } = boxFaces(2, 4, 0, 1);
    const drawing = await planCut([
      mesh(Object.values(outer), { color: [1, 0, 0, 1] }),
      mesh(Object.values(inner), { color: [0, 0, 1, 1] }),
    ]);
    expect(drawing.cutPolygons.map((p) => p.color)).toEqual([[1, 0, 0, 1], [0, 0, 1, 1]]);
    expect(flagged(drawing)).toEqual([]);
  });
});
