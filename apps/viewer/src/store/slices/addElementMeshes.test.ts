/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `buildElementMesh` turns a builder-tool payload into a renderer-frame
 * preview mesh. It's a pure function (no store state), but the coordinate
 * transform (IFC Z-up storey-local -> renderer Y-up) and the per-shape
 * vertex/normal/index math are exactly the kind of thing that silently
 * drifts wrong without anyone noticing — a flipped normal still renders
 * *something*, it just lights backwards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildElementMesh, type ElementBuildContext, type ElementMeshPayload } from './addElementMeshes.js';

function ctx(payload: ElementMeshPayload, overrides: Partial<ElementBuildContext> = {}): ElementBuildContext {
  return {
    type: payload.type,
    globalId: 42,
    storeyElevation: 0,
    payload,
    ...overrides,
  };
}

describe('buildElementMesh: linear shapes (wall / beam / member)', () => {
  it('builds a wall box tagged with the given globalId and IfcWall type', () => {
    const mesh = buildElementMesh(
      ctx({ type: 'wall', params: { Thickness: 0.2, Height: 3 }, start: [0, 0, 0], end: [4, 0, 0] }),
    );
    assert.ok(mesh);
    assert.equal(mesh.expressId, 42);
    assert.equal(mesh.ifcType, 'IfcWall');
    // Box: 6 faces * 4 verts = 24 verts, 6 faces * 2 tris = 12 tris (36 indices).
    assert.equal(mesh.positions.length, 24 * 3);
    assert.equal(mesh.indices.length, 36);
    assert.ok(mesh.entityIds);
    assert.ok([...mesh.entityIds!].every((id) => id === 42));
  });

  it('returns null for a zero-length wall segment (degenerate, not a size-0 box)', () => {
    const mesh = buildElementMesh(
      ctx({ type: 'wall', params: { Thickness: 0.2, Height: 3 }, start: [1, 1, 0], end: [1, 1, 0] }),
    );
    assert.equal(mesh, null);
  });

  it('beam cross-section uses Width, not Thickness — beam params have no Thickness field', () => {
    // buildLinearBox picks `'Thickness' in params ? Thickness : Width`.
    // AddElementBeamParams is {Width, Height}; confirm the box's cross-section
    // half-width actually reflects Width, not some other field / a stale default.
    const width = 0.3;
    const mesh = buildElementMesh(
      ctx({ type: 'beam', params: { Width: width, Height: 0.5 }, start: [0, 0, 0], end: [2, 0, 0] }),
    );
    assert.ok(mesh);
    // Segment runs along +X, so cross-section spans Y. Bottom-face verts (first 4)
    // should span exactly `width` in Y (renderer Z, since IFC Y -> renderer -Z).
    const zs: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) zs.push(mesh.positions[i + 2]);
    const spanZ = Math.max(...zs) - Math.min(...zs);
    assert.ok(Math.abs(spanZ - width) < 1e-6, `expected Y-span ${width}, got ${spanZ}`);
  });

  it('sloped beam: bottom ring follows each endpoint\'s own Z rather than pinning to the start Z', () => {
    // Per the buildLinearBox docstring, walls reject sloped axes upstream but
    // beams/members don't — the bottom ring must track start/end Z independently.
    const mesh = buildElementMesh(
      ctx({
        type: 'beam',
        params: { Width: 0.2, Height: 0.4 },
        start: [0, 0, 0],
        end: [4, 0, 2],
      }),
    );
    assert.ok(mesh);
    const ys = new Set<number>();
    for (let i = 0; i < mesh.positions.length; i += 3) ys.add(Math.round(mesh.positions[i + 1] * 1e6) / 1e6);
    // Expect renderer-Y (= IFC Z + storeyElevation + optional Height) values at
    // both the start end (0, 0.4) and the far end (2, 2.4) — not a single flat pair.
    assert.ok(ys.has(0), 'missing start-end base Y');
    assert.ok(ys.has(2), 'missing end-end base Y');
    assert.ok(ys.has(0.4), 'missing start-end top Y');
    assert.ok(ys.has(2.4), 'missing end-end top Y');
  });
});

describe('buildElementMesh: axis-aligned boxes (column / door / window)', () => {
  it('column box is centred on `position` with the given Width/Depth/Height extents', () => {
    const mesh = buildElementMesh(
      ctx({ type: 'column', params: { Width: 0.4, Depth: 0.6, Height: 3 }, position: [10, 20, 5] }),
    );
    assert.ok(mesh);
    assert.equal(mesh.ifcType, 'IfcColumn');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i]); maxX = Math.max(maxX, mesh.positions[i]);
      minY = Math.min(minY, mesh.positions[i + 1]); maxY = Math.max(maxY, mesh.positions[i + 1]);
      minZ = Math.min(minZ, mesh.positions[i + 2]); maxZ = Math.max(maxZ, mesh.positions[i + 2]);
    }
    // Renderer X == IFC X, so X should span [10-0.2, 10+0.2].
    assert.ok(Math.abs(minX - 9.8) < 1e-6 && Math.abs(maxX - 10.2) < 1e-6);
    // Renderer Y == IFC Z (+ storeyElevation=0): [5, 8].
    assert.ok(Math.abs(minY - 5) < 1e-6 && Math.abs(maxY - 8) < 1e-6);
    // Renderer Z == -IFC Y: IFC Y spans [20-0.3, 20+0.3] -> renderer Z spans [-20.3, -19.7].
    assert.ok(Math.abs(minZ - (-20.3)) < 1e-6 && Math.abs(maxZ - (-19.7)) < 1e-6);
  });

  it('door box uses FrameThickness as the Y-extent, not Width twice', () => {
    const mesh = buildElementMesh(
      ctx({ type: 'door', params: { Width: 1, Height: 2.1, FrameThickness: 0.05 }, position: [0, 0, 0] }),
    );
    assert.ok(mesh);
    assert.equal(mesh.ifcType, 'IfcDoor');
    const zs: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) zs.push(mesh.positions[i + 2]);
    const spanZ = Math.max(...zs) - Math.min(...zs);
    assert.ok(Math.abs(spanZ - 0.05) < 1e-6, `expected FrameThickness span 0.05, got ${spanZ}`);
  });

  it('storeyElevation shifts the box up in renderer-Y without touching X/Z', () => {
    const flat = buildElementMesh(
      ctx({ type: 'column', params: { Width: 0.4, Depth: 0.4, Height: 1 }, position: [0, 0, 0] }, { storeyElevation: 0 }),
    );
    const raised = buildElementMesh(
      ctx({ type: 'column', params: { Width: 0.4, Depth: 0.4, Height: 1 }, position: [0, 0, 0] }, { storeyElevation: 10 }),
    );
    assert.ok(flat && raised);
    for (let i = 0; i < flat.positions.length; i += 3) {
      assert.ok(Math.abs(flat.positions[i] - raised.positions[i]) < 1e-9, 'X must not shift');
      assert.ok(Math.abs(flat.positions[i + 2] - raised.positions[i + 2]) < 1e-9, 'Z must not shift');
      assert.ok(
        Math.abs(raised.positions[i + 1] - flat.positions[i + 1] - 10) < 1e-9,
        'Y must shift by exactly storeyElevation',
      );
    }
  });
});

describe('buildElementMesh: box side-face normals point outward', () => {
  // A box's outward normal on any side face must point AWAY from the box
  // centre. If it points inward, every dot(normal, cameraDir) lighting
  // calculation for that face is backwards.
  it('every triangle normal points away from the box centre (renderer frame)', () => {
    const position: [number, number, number] = [0, 1, 0];
    const height = 2;
    const mesh = buildElementMesh(
      ctx({ type: 'column', params: { Width: 2, Depth: 2, Height: height }, position }),
    );
    assert.ok(mesh);
    // Renderer frame: X<-IFC X, Y<-IFC Z(+elevation)+Height/2 for the centre, Z<- -IFC Y.
    const centre = [position[0], position[2] + height / 2, -position[1]];
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const px = mesh.positions[v * 3] - centre[0];
      const py = mesh.positions[v * 3 + 1] - centre[1];
      const pz = mesh.positions[v * 3 + 2] - centre[2];
      const nx = mesh.normals[v * 3];
      const ny = mesh.normals[v * 3 + 1];
      const nz = mesh.normals[v * 3 + 2];
      const dot = px * nx + py * ny + pz * nz;
      assert.ok(
        dot > 0,
        `vertex ${v} normal (${nx},${ny},${nz}) points toward centre from offset (${px},${py},${pz}); dot=${dot}`,
      );
    }
  });
});

describe('buildElementMesh: polygon extrusion (slab / roof / plate / space)', () => {
  const square: [number, number, number][] = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 3, 0],
    [0, 3, 0],
  ];

  it('slab vertex/triangle counts follow the 2n / (4n-4) formula for a quad footprint', () => {
    const mesh = buildElementMesh(ctx({ type: 'slab', params: { Width: 4, Depth: 3, Thickness: 0.2 }, corners: square }));
    assert.ok(mesh);
    assert.equal(mesh.ifcType, 'IfcSlab');
    const n = square.length;
    assert.equal(mesh.positions.length, 2 * n * 3);
    assert.equal(mesh.indices.length, (4 * n - 4) * 3);
  });

  it('returns null for a degenerate footprint (< 3 corners)', () => {
    const mesh = buildElementMesh(
      ctx({ type: 'slab', params: { Width: 1, Depth: 1, Thickness: 0.2 }, corners: [[0, 0, 0], [1, 0, 0]] }),
    );
    assert.equal(mesh, null);
  });

  it('returns null for non-positive thickness', () => {
    const mesh = buildElementMesh(ctx({ type: 'slab', params: { Width: 4, Depth: 3, Thickness: 0 }, corners: square }));
    assert.equal(mesh, null);
  });

  it('extrudes slabs/roofs/plates upward from the footprint Z, space extrudes upward by Height the same way', () => {
    const slab = buildElementMesh(ctx({ type: 'slab', params: { Width: 4, Depth: 3, Thickness: 0.3 }, corners: square }));
    const space = buildElementMesh(ctx({ type: 'space', params: { Width: 4, Depth: 3, Height: 0.3 }, corners: square }));
    assert.ok(slab && space);
    // Both extrude the same footprint by the same magnitude upward: top-ring Y
    // should be footprintZ(=0) + 0.3 for both, bottom ring at Y=0.
    const ysOf = (m: NonNullable<typeof slab>) => {
      const ys = new Set<number>();
      for (let i = 0; i < m.positions.length; i += 3) ys.add(Math.round(m.positions[i + 1] * 1e6) / 1e6);
      return ys;
    };
    assert.deepEqual([...ysOf(slab)].sort(), [0, 0.3]);
    assert.deepEqual([...ysOf(space)].sort(), [0, 0.3]);
  });

  it('renderer-frame mapping: X<-IFC X, Y<-IFC Z(+elevation), Z<- -IFC Y', () => {
    const mesh = buildElementMesh(ctx({ type: 'slab', params: { Width: 4, Depth: 3, Thickness: 0.2 }, corners: square }, { storeyElevation: 5 }));
    assert.ok(mesh);
    // Bottom-ring vertex 0 corresponds to footprint corner [0,0,0].
    assert.equal(mesh.positions[0], 0); // X
    assert.equal(mesh.positions[1], 5); // Y = footprintZ(0) + storeyElevation(5)
    assert.equal(mesh.positions[2], -0); // Z = -Y(0)
    // Bottom-ring vertex 1 corresponds to footprint corner [4,0,0].
    assert.equal(mesh.positions[3], 4);
    // Bottom-ring vertex 2 corresponds to footprint corner [4,3,0] -> renderer Z = -3.
    assert.equal(mesh.positions[8], -3);
  });
});

describe('buildElementMesh: repeated calls are independent', () => {
  it('two calls for the same payload return distinct array instances, not shared/aliased buffers', () => {
    const payload: ElementMeshPayload = { type: 'wall', params: { Thickness: 0.2, Height: 3 }, start: [0, 0, 0], end: [4, 0, 0] };
    const a = buildElementMesh(ctx(payload, { globalId: 1 }));
    const b = buildElementMesh(ctx(payload, { globalId: 2 }));
    assert.ok(a && b);
    assert.notEqual(a.positions, b.positions, 'position buffers must not be the same array instance');
    assert.notEqual(a.indices, b.indices, 'index buffers must not be the same array instance');
    assert.deepEqual([...a.positions], [...b.positions], 'geometry itself should be identical, only the tag differs');
    assert.equal(a.expressId, 1);
    assert.equal(b.expressId, 2);
    assert.ok([...a.entityIds!].every((id) => id === 1));
    assert.ok([...b.entityIds!].every((id) => id === 2));
  });
});
