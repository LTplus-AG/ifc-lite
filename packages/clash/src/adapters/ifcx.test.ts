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
        children: {
          WallA: 'Project/WallA',
          WallB: 'Project/WallB',
          WallC: 'Project/WallC',
        },
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
      // WallC is a SINGLE entity (one durable prim path) that owns TWO
      // mesh-bearing descendants: a `Body` and an `Axis`. Neither child carries
      // `bsi::ifc::class`, so the IFCX geometry extractor associates BOTH
      // meshes with WallC's expressId — emitting two `MeshData` that share a
      // prim path. The adapter must coalesce these into ONE ClashElement.
      {
        path: 'Project/WallC',
        attributes: {
          'bsi::ifc::class': ifcClass('IfcWall'),
          'bsi::ifc::name': 'Wall C',
        },
        children: {
          Body: 'Project/WallC/Body',
          Axis: 'Project/WallC/Axis',
        },
      },
      {
        path: 'Project/WallC/Body',
        attributes: { 'usd::usdgeom::mesh': cubeMesh(10, 0, 0, 1) },
      },
      {
        path: 'Project/WallC/Axis',
        // A second, disjoint sub-mesh under the same wall entity.
        attributes: { 'usd::usdgeom::mesh': cubeMesh(12, 0, 0, 1) },
      },
    ],
  };
}

function ifcxBuffer(): ArrayBuffer {
  const json = JSON.stringify(buildIfcxFile());
  return new TextEncoder().encode(json).buffer as ArrayBuffer;
}

function isDegenerate(bounds: { min: number[]; max: number[] }): boolean {
  // Degenerate if ANY axis has zero/negative extent (a flat or empty mesh).
  return (
    bounds.max[0] <= bounds.min[0] ||
    bounds.max[1] <= bounds.min[1] ||
    bounds.max[2] <= bounds.min[2]
  );
}

describe('elementsFromIfcx', () => {
  it('maps IFCX prims into ClashElements with prim-path keys, tags and bounds', async () => {
    const { elements } = await elementsFromIfcx({
      buffer: ifcxBuffer(),
      modelId: 'ifcx-model',
    });

    expect(elements).toHaveLength(3);

    const keys = elements.map((e) => e.key).sort();
    expect(keys).toEqual(['Project/WallA', 'Project/WallB', 'Project/WallC']);

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

  it('offsets each submesh\'s indices by the running vertex count when merging WallC\'s Body+Axis', async () => {
    // Pins the vertex-index offset applied inside the adapter's internal
    // `mergeMeshes` (not exported; reached here through the public
    // `elementsFromIfcx` result, whose `ClashElement.indices` is exactly
    // `mergeMeshes`'s output). WallC owns two disjoint 8-vertex/36-index cube
    // submeshes — Body at world x in [10,11] and Axis at world x in [12,13]
    // (see `buildIfcxFile()` above) — so the merged buffer's second submesh
    // block must have its indices shifted by the first submesh's vertex
    // count (8) to address the right half of the concatenated position
    // array. `bounds` and `isDegenerate` (used by the other tests in this
    // file) are blind to this: they derive purely from `positions`, which is
    // never mis-offset, only `indices` is. Coverage gap and mutation
    // verification are documented in the PR for this test.
    const { elements } = await elementsFromIfcx({
      buffer: ifcxBuffer(),
      modelId: 'ifcx-model',
    });
    const wallC = elements.find((e) => e.key === 'Project/WallC');
    expect(wallC).toBeDefined();

    // Two 8-vertex / 36-index cubes concatenated.
    expect(wallC!.positions.length).toBe(8 * 3 * 2);
    expect(wallC!.indices.length).toBe(36 * 2);

    const FACE = cubeMesh(0, 0, 0, 1).faceVertexIndices; // same triangulation pattern for both cubes

    const firstBlock = Array.from(wallC!.indices.slice(0, 36));
    const secondBlock = Array.from(wallC!.indices.slice(36));

    // The first submesh's vertexBase is always 0, so its indices are the
    // untouched 0..7 pattern.
    expect(firstBlock).toEqual(FACE);
    // The second submesh must be shifted into the 8..15 range — the offset
    // under test. Dropping `+ vertexBase` in `mergeMeshes` would leave this
    // identical to `firstBlock`, aliasing the second submesh's triangles
    // back onto the first submesh's vertices.
    expect(secondBlock).toEqual(FACE.map((i) => i + 8));

    // Tie the offset to real geometry, not just index numbers: resolve every
    // index through `positions` and confirm it lands in the right cube's
    // x-range. World x is preserved by the IFCX Z-up -> Y-up conversion (only
    // y/z are remapped), so Body's vertices are x in [10,11] and Axis's are
    // x in [12,13], independent of which submesh the extractor visits first.
    const xRangeOf = (idx: number) => wallC!.positions[idx * 3];
    const firstBlockXs = firstBlock.map(xRangeOf);
    const secondBlockXs = secondBlock.map(xRangeOf);
    const inBodyRange = (x: number) => x >= 10 && x <= 11;
    const inAxisRange = (x: number) => x >= 12 && x <= 13;
    const firstIsBody = firstBlockXs.every(inBodyRange);
    const firstIsAxis = firstBlockXs.every(inAxisRange);
    expect(firstIsBody || firstIsAxis).toBe(true);
    if (firstIsBody) {
      expect(secondBlockXs.every(inAxisRange)).toBe(true);
    } else {
      expect(secondBlockXs.every(inBodyRange)).toBe(true);
    }
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

/**
 * A project containing a physical wall PLUS the same non-physical / container
 * classes `adapters/step.ts` drops (#1464): an opening, a space, and a
 * storey that (as IFC4.3 infra exports routinely do) carries its own
 * tessellated geometry. Every non-wall node here carries mesh geometry, so a
 * missing filter lets all of them through as ordinary `ClashElement`s.
 */
function buildNonClashableIfcxFile() {
  const ifcClass = (code: string) => ({
    code,
    uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`,
  });

  return {
    header: {
      id: 'clash-ifcx-nonclashable-fixture',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'ifc-lite clash adapter test',
      timestamp: '2025-01-01T00:00:00Z',
    },
    imports: [],
    schemas: {
      'bsi::ifc::class': { value: SCHEMA_VALUE },
      'usd::usdgeom::mesh': { value: SCHEMA_VALUE },
    },
    data: [
      {
        path: 'Project',
        attributes: { 'bsi::ifc::class': ifcClass('IfcProject') },
        children: {
          Storey: 'Project/Storey',
          Opening: 'Project/Opening',
          Space: 'Project/Space',
        },
      },
      {
        // Spatial container carrying its own geometry (follow-up to #1464).
        path: 'Project/Storey',
        attributes: { 'bsi::ifc::class': ifcClass('IfcBuildingStorey') },
        children: { Body: 'Project/Storey/Body', Wall: 'Project/Storey/Wall' },
      },
      {
        path: 'Project/Storey/Body',
        attributes: { 'usd::usdgeom::mesh': cubeMesh(0, 0, 0, 10) },
      },
      {
        // The one physical element in the fixture.
        path: 'Project/Storey/Wall',
        attributes: { 'bsi::ifc::class': ifcClass('IfcWall') },
        children: { Body: 'Project/Storey/Wall/Body' },
      },
      {
        path: 'Project/Storey/Wall/Body',
        attributes: { 'usd::usdgeom::mesh': cubeMesh(1, 1, 1, 1) },
      },
      {
        path: 'Project/Opening',
        attributes: { 'bsi::ifc::class': ifcClass('IfcOpeningElement') },
        children: { Body: 'Project/Opening/Body' },
      },
      {
        path: 'Project/Opening/Body',
        attributes: { 'usd::usdgeom::mesh': cubeMesh(2, 2, 2, 1) },
      },
      {
        path: 'Project/Space',
        attributes: { 'bsi::ifc::class': ifcClass('IfcSpace') },
        children: { Body: 'Project/Space/Body' },
      },
      {
        path: 'Project/Space/Body',
        attributes: { 'usd::usdgeom::mesh': cubeMesh(3, 3, 3, 1) },
      },
    ],
  };
}

function nonClashableIfcxBuffer(): ArrayBuffer {
  const json = JSON.stringify(buildNonClashableIfcxFile());
  return new TextEncoder().encode(json).buffer as ArrayBuffer;
}

describe('elementsFromIfcx - drops non-physical / container classes (parity with step.ts, #1464)', () => {
  it('drops IfcOpeningElement, IfcSpace and the spatial-container IfcBuildingStorey, keeping only IfcWall', async () => {
    const { elements } = await elementsFromIfcx({
      buffer: nonClashableIfcxBuffer(),
      modelId: 'ifcx-model',
    });

    const keys = elements.map((e) => e.key).sort();
    expect(keys).toEqual(['Project/Storey/Wall']);
    expect(elements[0].tag).toBe('IfcWall');
  });
});
