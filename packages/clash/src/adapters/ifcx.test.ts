/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { elementsFromIfcx } from './ifcx.js';
import { createClashEngine } from '../engine.js';
import type { ClashRule } from '../types.js';

/**
 * Build a closed axis-aligned cube as a USD-style mesh (Z-up `points` +
 * triangle `faceVertexIndices`), the genuine IFCX geometry encoding consumed
 * by `@ifc-lite/ifcx`'s geometry extractor.
 */
function cubeMesh(ox: number, oy: number, oz: number, size: number) {
  const s = size;
  const points: number[][] = [
    [ox, oy, oz],
    [ox + s, oy, oz],
    [ox + s, oy + s, oz],
    [ox, oy + s, oz],
    [ox, oy, oz + s],
    [ox + s, oy, oz + s],
    [ox + s, oy + s, oz + s],
    [ox, oy + s, oz + s],
  ];
  // 12 triangles (2 per face), wound for a closed solid.
  const faceVertexIndices = [
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // -y
    1, 2, 6, 1, 6, 5, // +x
    2, 3, 7, 2, 7, 6, // +y
    3, 0, 4, 3, 4, 7, // -x
  ];
  return { points, faceVertexIndices };
}

const SCHEMA_VALUE = { dataType: 'Object' as const };

/**
 * A minimal but genuine IFCX (IFC5 JSON) file: a project root that contains
 * two overlapping walls, each with a `Body` child carrying USD mesh geometry.
 * This is the real wire format `parseIfcx` consumes (header + USD `data`
 * nodes with `bsi::ifc::class` + `usd::usdgeom::mesh` + `children`), so the
 * test exercises the real composition / entity / geometry extraction path.
 */
function buildIfcxFile() {
  const ifcClass = (code: string) => ({
    code,
    uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`,
  });

  return {
    header: {
      id: 'clash-ifcx-fixture',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'ifc-lite clash adapter test',
      timestamp: '2025-01-01T00:00:00Z',
    },
    imports: [],
    schemas: {
      'bsi::ifc::class': { value: SCHEMA_VALUE },
      'bsi::ifc::name': { value: { dataType: 'String' as const } },
      'usd::usdgeom::mesh': { value: SCHEMA_VALUE },
    },
    data: [
      {
        path: 'Project',
        attributes: { 'bsi::ifc::class': ifcClass('IfcProject') },
        children: { WallA: 'Project/WallA', WallB: 'Project/WallB' },
      },
      {
        path: 'Project/WallA',
        attributes: {
          'bsi::ifc::class': ifcClass('IfcWall'),
          'bsi::ifc::name': 'Wall A',
        },
        children: { Body: 'Project/WallA/Body' },
      },
      {
        path: 'Project/WallA/Body',
        attributes: { 'usd::usdgeom::mesh': cubeMesh(0, 0, 0, 1) },
      },
      {
        path: 'Project/WallB',
        attributes: {
          'bsi::ifc::class': ifcClass('IfcWall'),
          'bsi::ifc::name': 'Wall B',
        },
        children: { Body: 'Project/WallB/Body' },
      },
      {
        path: 'Project/WallB/Body',
        // Offset by 0.5 so WallB genuinely interpenetrates WallA.
        attributes: { 'usd::usdgeom::mesh': cubeMesh(0.5, 0, 0, 1) },
      },
    ],
  };
}

function ifcxBuffer(): ArrayBuffer {
  const json = JSON.stringify(buildIfcxFile());
  return new TextEncoder().encode(json).buffer as ArrayBuffer;
}

function isDegenerate(bounds: { min: number[]; max: number[] }): boolean {
  return (
    bounds.max[0] <= bounds.min[0] &&
    bounds.max[1] <= bounds.min[1] &&
    bounds.max[2] <= bounds.min[2]
  );
}

describe('elementsFromIfcx', () => {
  it('maps IFCX prims into ClashElements with prim-path keys, tags and bounds', async () => {
    const { elements } = await elementsFromIfcx({
      buffer: ifcxBuffer(),
      modelId: 'ifcx-model',
    });

    expect(elements).toHaveLength(2);

    const keys = elements.map((e) => e.key).sort();
    expect(keys).toEqual(['Project/WallA', 'Project/WallB']);

    for (const el of elements) {
      // key is the durable USD prim path
      expect(el.key.startsWith('Project/Wall')).toBe(true);
      // tag carries the IFC class from bsi::ifc::class
      expect(el.tag).toBe('IfcWall');
      expect(el.model).toBe('ifcx-model');
      // ref is a deterministic non-negative integer derived from the path
      expect(el.ref).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(el.ref)).toBe(true);
      // non-degenerate, world-space bounds from real tessellated geometry
      expect(isDegenerate(el.bounds)).toBe(false);
      expect(el.positions.length).toBeGreaterThan(0);
      expect(el.indices.length).toBeGreaterThan(0);
    }
  });

  it('derives a deterministic ref purely from the prim path', async () => {
    const a = await elementsFromIfcx({ buffer: ifcxBuffer(), modelId: 'm' });
    const b = await elementsFromIfcx({ buffer: ifcxBuffer(), modelId: 'm' });
    const refsA = a.elements.map((e) => `${e.key}=${e.ref}`).sort();
    const refsB = b.elements.map((e) => `${e.key}=${e.ref}`).sort();
    expect(refsA).toEqual(refsB);
    // distinct paths => distinct refs in this fixture
    const refs = new Set(a.elements.map((e) => e.ref));
    expect(refs.size).toBe(a.elements.length);
  });

  it('runs the SAME clash core end-to-end on IFCX-sourced elements', async () => {
    const { elements, exclusions } = await elementsFromIfcx({
      buffer: ifcxBuffer(),
      modelId: 'ifcx-model',
    });

    // Permissive self-clash: every IfcWall vs every other IfcWall.
    const rule: ClashRule = {
      id: 'wall-vs-wall',
      name: 'Wall self-clash',
      a: 'IfcWall',
      mode: 'hard',
    };

    const engine = createClashEngine({ backend: 'ts' });
    // First prove the geometry overlaps (no exclusions applied).
    const open = await engine.run(elements, [rule], { excludeVoidsAndHosts: false });
    expect(open.clashes.length).toBe(1);
    const clash = open.clashes[0];
    expect(clash.status).toBe('hard');
    expect(clash.distance).toBeLessThan(0); // interpenetration
    expect([clash.a.tag, clash.b.tag]).toEqual(['IfcWall', 'IfcWall']);
    expect(open.summary.total).toBe(1);

    // The two sibling walls are NOT in a parent/child composition relation,
    // so the adapter exclusions must not suppress this real clash.
    const withExclusions = await engine.run(elements, [rule], { exclusions });
    expect(withExclusions.clashes.length).toBe(1);
  });

  it('excludes composition parent/child pairs but keeps the set otherwise', async () => {
    const { elements, exclusions } = await elementsFromIfcx({
      buffer: ifcxBuffer(),
      modelId: 'ifcx-model',
    });
    // Only the two leaf walls carry geometry; the IfcProject parent has no mesh
    // and thus no element, so no parent/child pair survives among meshed
    // elements. The sibling walls are correctly NOT excluded.
    expect(exclusions.size).toBe(0);
    expect(elements.every((e) => e.tag === 'IfcWall')).toBe(true);
  });
});
