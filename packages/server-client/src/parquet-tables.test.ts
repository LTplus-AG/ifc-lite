// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract tests for the Parquet column semantics (issue #1841).
 *
 * The bug was that this decoder silently dropped `origin` / `geometry_class`,
 * so origin-relative and instanced geometry collapsed onto the world origin.
 * Nothing failed, because `@ifc-lite/server-client` had no tests at all. These
 * pin the exact seam: which columns are read, when they are trusted, and what
 * shape a mesh decodes to when they are absent.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMeshesFromTables,
  buildMeshesFromOptimizedTables,
  type ArrowTableLike,
} from './parquet-tables.js';

/** Minimal stand-in for an `apache-arrow` Table over plain arrays. */
function table(columns: Record<string, ArrayLike<number> | string[]>): ArrowTableLike {
  return {
    getChild(name: string) {
      const col = columns[name];
      if (col === undefined) return null;
      return {
        toArray: () => col as ArrayLike<number>,
        get: (i: number) => (col as ArrayLike<unknown>)[i],
      };
    },
  };
}

// One triangle, shared by every standard-format fixture below.
const vertexTable = table({
  x: new Float32Array([0, 1, 1]),
  y: new Float32Array([0, 0, 1]),
  z: new Float32Array([0, 0, 0]),
  nx: new Float32Array([0, 0, 0]),
  ny: new Float32Array([1, 1, 1]),
  nz: new Float32Array([0, 0, 0]),
});
const indexTable = table({
  i0: new Uint32Array([0]),
  i1: new Uint32Array([1]),
  i2: new Uint32Array([2]),
});

/** Mesh table for `count` meshes, all pointing at the single shared triangle. */
function meshTable(count: number, extra: Record<string, ArrayLike<number>> = {}) {
  return table({
    express_id: new Uint32Array(Array.from({ length: count }, (_, i) => 100 + i)),
    ifc_type: Array.from({ length: count }, () => 'IfcSlab'),
    vertex_start: new Uint32Array(count),
    vertex_count: new Uint32Array(count).fill(3),
    index_start: new Uint32Array(count),
    index_count: new Uint32Array(count).fill(3),
    color_r: new Float32Array(count).fill(0.5),
    color_g: new Float32Array(count).fill(0.5),
    color_b: new Float32Array(count).fill(0.5),
    color_a: new Float32Array(count).fill(1),
    ...extra,
  });
}

describe('buildMeshesFromTables (standard format)', () => {
  it('carries the per-mesh origin and geometry_class through', () => {
    const meshes = buildMeshesFromTables(
      meshTable(1, {
        origin_x: new Float64Array([1000.5]),
        origin_y: new Float64Array([30]),
        origin_z: new Float64Array([-2000.25]),
        geometry_class: new Uint8Array([2]),
      }),
      vertexTable,
      indexTable
    );

    expect(meshes[0].origin).toEqual([1000.5, 30, -2000.25]);
    expect(meshes[0].geometry_class).toBe(2);
    // The origin is NOT baked into the positions — that is what keeps f32
    // precision at building / georeferenced scale.
    expect(Array.from(meshes[0].positions.slice(0, 3))).toEqual([0, 0, 0]);
  });

  it('omits both fields when the columns are absent (pre-#1841 server)', () => {
    const [mesh] = buildMeshesFromTables(meshTable(1), vertexTable, indexTable);
    expect('origin' in mesh).toBe(false);
    expect('geometry_class' in mesh).toBe(false);
  });

  it('omits an all-zero origin and a zero geometry_class', () => {
    const [mesh] = buildMeshesFromTables(
      meshTable(1, {
        origin_x: new Float64Array([0]),
        origin_y: new Float64Array([0]),
        origin_z: new Float64Array([0]),
        geometry_class: new Uint8Array([0]),
      }),
      vertexTable,
      indexTable
    );
    expect('origin' in mesh).toBe(false);
    expect('geometry_class' in mesh).toBe(false);
  });

  it('keeps an origin that is zero on only some axes', () => {
    const [mesh] = buildMeshesFromTables(
      meshTable(1, {
        origin_x: new Float64Array([0]),
        origin_y: new Float64Array([0]),
        origin_z: new Float64Array([-20]),
      }),
      vertexTable,
      indexTable
    );
    expect(mesh.origin).toEqual([0, 0, -20]);
  });

  it('ignores a partial origin column set rather than reading undefined -> NaN', () => {
    const [mesh] = buildMeshesFromTables(
      // origin_z missing: the triplet is unusable.
      meshTable(1, {
        origin_x: new Float64Array([10]),
        origin_y: new Float64Array([20]),
      }),
      vertexTable,
      indexTable
    );
    expect('origin' in mesh).toBe(false);
  });

  it('ignores origin columns that are not parallel to the mesh rows', () => {
    const meshes = buildMeshesFromTables(
      // Two meshes, but only one origin row (truncated payload).
      meshTable(2, {
        origin_x: new Float64Array([10]),
        origin_y: new Float64Array([20]),
        origin_z: new Float64Array([30]),
        geometry_class: new Uint8Array([1]),
      }),
      vertexTable,
      indexTable
    );
    expect(meshes).toHaveLength(2);
    for (const mesh of meshes) {
      expect('origin' in mesh).toBe(false);
      expect('geometry_class' in mesh).toBe(false);
    }
  });

  it('gives every mesh its own origin', () => {
    const meshes = buildMeshesFromTables(
      meshTable(3, {
        origin_x: new Float64Array([1, 2, 3]),
        origin_y: new Float64Array([0, 0, 0]),
        origin_z: new Float64Array([0, 0, 0]),
      }),
      vertexTable,
      indexTable
    );
    expect(meshes.map((m) => m.origin?.[0])).toEqual([1, 2, 3]);
  });

  it('omits an all-NaN origin instead of hiding corruption as world-baked', () => {
    const [mesh] = buildMeshesFromTables(
      meshTable(1, {
        origin_x: new Float64Array([NaN]),
        origin_y: new Float64Array([NaN]),
        origin_z: new Float64Array([NaN]),
      }),
      vertexTable,
      indexTable
    );
    expect('origin' in mesh).toBe(false);
  });

  it('omits a PARTIALLY-NaN origin rather than letting NaN reach MeshData.origin', () => {
    const [mesh] = buildMeshesFromTables(
      // origin_x is NaN; origin_y/origin_z are finite non-zero, so the old
      // `||` truthiness check would have let this triplet through with the
      // NaN intact — poisoning downstream bounds/position math.
      meshTable(1, {
        origin_x: new Float64Array([NaN]),
        origin_y: new Float64Array([5]),
        origin_z: new Float64Array([0]),
      }),
      vertexTable,
      indexTable
    );
    expect('origin' in mesh).toBe(false);
    // Belt and braces: even if a future change re-adds `origin`, it must
    // never contain a NaN component.
    if (mesh.origin) {
      expect(mesh.origin.every((c) => Number.isFinite(c))).toBe(true);
    }
  });

  it('throws on a missing required vertex column instead of decoding NaN geometry', () => {
    const brokenVertices = table({
      x: new Float32Array([0, 1, 1]),
      y: new Float32Array([0, 0, 1]),
      // z missing
      nx: new Float32Array([0, 0, 0]),
      ny: new Float32Array([1, 1, 1]),
      nz: new Float32Array([0, 0, 0]),
    });
    expect(() => buildMeshesFromTables(meshTable(1), brokenVertices, indexTable)).toThrow(
      /missing required vertex\/index column/
    );
  });
});

/** Two instances of ONE deduplicated template triangle. */
function optimizedFixture(extra: Record<string, ArrayLike<number>> = {}) {
  return {
    instanceArrow: table({
      entity_id: new Uint32Array([10, 11]),
      ifc_type: ['IfcSlab', 'IfcSlab'],
      mesh_index: new Uint32Array([0, 0]),
      material_index: new Uint32Array([0, 0]),
      ...extra,
    }),
    meshArrow: table({
      vertex_offset: new Uint32Array([0]),
      vertex_count: new Uint32Array([3]),
      index_offset: new Uint32Array([0]),
      index_count: new Uint32Array([3]),
    }),
    materialArrow: table({
      r: new Uint8Array([255]),
      g: new Uint8Array([0]),
      b: new Uint8Array([0]),
      a: new Uint8Array([255]),
    }),
    vertexArrow: table({
      // Quantized: metres = value / vertexMultiplier.
      x: new Int32Array([0, 10000, 10000]),
      y: new Int32Array([0, 0, 10000]),
      z: new Int32Array([0, 0, 0]),
    }),
    indexArrow: table({ i: new Uint32Array([0, 1, 2]) }),
    hasNormals: false,
    vertexMultiplier: 10000,
  };
}

describe('source ids on the standard format (#3215)', () => {
  it('decodes both disjoint ids when their columns are present', () => {
    const meshes = buildMeshesFromTables(
      meshTable(1, {
        geometry_item_id: new Uint32Array([501]),
        // The writer's absent marker. Non-nullable column, explicit sentinel:
        // a NULLABLE column's values buffer is undefined at null rows and
        // parquet-wasm 0.7.x leaks the neighbouring row's id into it, so a
        // material-less mesh decoded as a real-looking id for another entity.
        material_id: new Uint32Array([0xffffffff]),
      }),
      vertexTable,
      indexTable
    );
    expect(meshes[0].geometry_item_id).toBe(501);
    expect('material_id' in meshes[0]).toBe(false);
  });

  it('a LEAKED neighbour id is still rejected — the sentinel, not truthiness', () => {
    // The failure the sentinel exists for: on parquet-wasm 0.7.x a null row's
    // slot held the NEXT row's real id (902 in the measured case). Truthiness
    // alone passes that straight through as a drill target for the wrong
    // entity. With the non-nullable sentinel there is no null row to leak into,
    // and a decoder seeing the marker rejects it whatever its numeric value.
    const meshes = buildMeshesFromTables(
      meshTable(2, {
        // Row 0 absent, row 1 real. Under the old nullable encoding row 0's
        // slot would have read 902.
        material_id: new Uint32Array([0xffffffff, 902]),
      }),
      vertexTable,
      indexTable
    );
    expect('material_id' in meshes[0]).toBe(false);
    expect(meshes[1].material_id).toBe(902);
  });

  it('decodes to the pre-#3215 shape when neither column is present', () => {
    // The compatibility property: a payload written before these columns
    // existed decodes exactly as it did, with no key added.
    const meshes = buildMeshesFromTables(meshTable(1), vertexTable, indexTable);
    expect('geometry_item_id' in meshes[0]).toBe(false);
    expect('material_id' in meshes[0]).toBe(false);
  });

  it('adding the columns perturbs NOTHING else — the additive-safety property', () => {
    // The compatibility question #3215 asks, answered rather than assumed.
    //
    // NEW decoder + OLD payload: getChild returns null, the guard is false, no
    // key appears. OLD decoder + NEW payload needs no test and cannot be
    // written here, because `numericColumn` selects BY NAME — a decoder that
    // never asks for a column cannot be perturbed by its presence.
    //
    // An earlier version of this comment went on to say no format-version bump
    // was needed and there was none to bump. Both halves were wrong. The server
    // keys its cached geometry blob `{cache_key}-parquet-v4`, and the optimized
    // blob carries a `[version:u8]` header. Without a bump a model parsed
    // before this deploy replays its old blob and the columns never appear —
    // the decoder handles that correctly and silently, which is the problem.
    // The key is v5 now.
    //
    // What IS worth pinning is that the new columns do not disturb the old
    // fields on the way past.
    const withIds = buildMeshesFromTables(
      meshTable(1, {
        origin_x: new Float64Array([1000.5]),
        origin_y: new Float64Array([2]),
        origin_z: new Float64Array([3]),
        geometry_class: new Uint8Array([2]),
        geometry_item_id: new Uint32Array([501]),
      }),
      vertexTable,
      indexTable
    );
    const withoutIds = buildMeshesFromTables(
      meshTable(1, {
        origin_x: new Float64Array([1000.5]),
        origin_y: new Float64Array([2]),
        origin_z: new Float64Array([3]),
        geometry_class: new Uint8Array([2]),
      }),
      vertexTable,
      indexTable
    );
    expect(withIds[0].origin).toEqual(withoutIds[0].origin);
    expect(withIds[0].geometry_class).toBe(withoutIds[0].geometry_class);
    expect(Array.from(withIds[0].positions)).toEqual(Array.from(withoutIds[0].positions));
    expect(Array.from(withIds[0].indices)).toEqual(Array.from(withoutIds[0].indices));
    // The only difference is the id itself.
    expect(withIds[0].geometry_item_id).toBe(501);
    expect('geometry_item_id' in withoutIds[0]).toBe(false);
  });

  it('ignores a source-id column that is not parallel to the mesh rows', () => {
    // Same structural guard the origin columns carry: a short column is a
    // malformed payload, and trusting it would hand row 1's id to row 0.
    const meshes = buildMeshesFromTables(
      meshTable(2, { geometry_item_id: new Uint32Array([501]) }),
      vertexTable,
      indexTable
    );
    expect('geometry_item_id' in meshes[0]).toBe(false);
  });
});

describe('buildMeshesFromOptimizedTables (instanced format)', () => {
  it('places each instance by its OWN origin even though geometry is shared', () => {
    const meshes = buildMeshesFromOptimizedTables(
      optimizedFixture({
        origin_x: new Float64Array([0, 5000]),
        origin_y: new Float64Array([0, 3]),
        origin_z: new Float64Array([0, -1000]),
        geometry_class: new Uint8Array([0, 2]),
      })
    );

    // Same template vertices for both instances...
    expect(Array.from(meshes[0].positions)).toEqual(Array.from(meshes[1].positions));
    // ...but distinct placements. Without this, "N slabs collapse to one".
    expect('origin' in meshes[0]).toBe(false); // all-zero origin is omitted
    expect(meshes[1].origin).toEqual([5000, 3, -1000]);
    expect(meshes[1].geometry_class).toBe(2);
  });

  it('carries each instance OWN source ids, not the shared template first one', () => {
    // The per-instance question #3215 asks, answered where it can actually be
    // wrong: two instances that dedupe to ONE geometry template can still come
    // from different IfcRepresentationItems -- the dedup key is the vertex data,
    // and identical geometry from two source items is what dedup exists for.
    // Hanging these off the template would hand instance 1 instance 0's id.
    const meshes = buildMeshesFromOptimizedTables(
      optimizedFixture({ geometry_item_id: new Uint32Array([501, 502]) })
    );
    expect(Array.from(meshes[0].positions)).toEqual(Array.from(meshes[1].positions));
    expect(meshes[0].geometry_item_id).toBe(501);
    expect(meshes[1].geometry_item_id).toBe(502);
  });

  it('omits origin / geometry_class when the columns are absent', () => {
    const meshes = buildMeshesFromOptimizedTables(optimizedFixture());
    for (const mesh of meshes) {
      expect('origin' in mesh).toBe(false);
      expect('geometry_class' in mesh).toBe(false);
    }
  });

  it('ignores instance origin columns that are not parallel to the instance rows', () => {
    const meshes = buildMeshesFromOptimizedTables(
      optimizedFixture({
        origin_x: new Float64Array([1]),
        origin_y: new Float64Array([2]),
        origin_z: new Float64Array([3]),
      })
    );
    for (const mesh of meshes) {
      expect('origin' in mesh).toBe(false);
    }
  });

  it('dequantizes vertices to metres and does not bake the origin in', () => {
    const [mesh] = buildMeshesFromOptimizedTables(
      optimizedFixture({
        origin_x: new Float64Array([5000, 5000]),
        origin_y: new Float64Array([0, 0]),
        origin_z: new Float64Array([0, 0]),
      })
    );
    expect(Array.from(mesh.positions.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
    expect(mesh.origin).toEqual([5000, 0, 0]);
  });

  it('omits an all-NaN instance origin instead of hiding corruption as world-baked', () => {
    const meshes = buildMeshesFromOptimizedTables(
      optimizedFixture({
        origin_x: new Float64Array([0, NaN]),
        origin_y: new Float64Array([0, NaN]),
        origin_z: new Float64Array([0, NaN]),
      })
    );
    expect('origin' in meshes[1]).toBe(false);
  });

  it('omits a PARTIALLY-NaN instance origin rather than letting NaN reach MeshData.origin', () => {
    const meshes = buildMeshesFromOptimizedTables(
      // Instance 1's origin_x is NaN; origin_y/origin_z are finite non-zero,
      // so the old `||` truthiness check would have let the NaN through.
      optimizedFixture({
        origin_x: new Float64Array([0, NaN]),
        origin_y: new Float64Array([0, 5]),
        origin_z: new Float64Array([0, -1000]),
      })
    );
    expect('origin' in meshes[1]).toBe(false);
    if (meshes[1].origin) {
      expect(meshes[1].origin.every((c) => Number.isFinite(c))).toBe(true);
    }
  });

  it('throws when an instance references a mesh or material that does not exist', () => {
    const fixture = optimizedFixture();
    fixture.instanceArrow = table({
      entity_id: new Uint32Array([10]),
      ifc_type: ['IfcSlab'],
      mesh_index: new Uint32Array([7]),
      material_index: new Uint32Array([0]),
    });
    expect(() => buildMeshesFromOptimizedTables(fixture)).toThrow(/references mesh 7/);
  });
});
