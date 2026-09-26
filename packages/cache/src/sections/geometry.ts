/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry serialization
 */

import type { MeshData } from '@ifc-lite/geometry';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { writeProvenance, readProvenance, provenanceByteLength, type AppearanceSourcePool } from './appearance-provenance.js';

/**
 * Validate + filter meshes (detached buffers / size mismatches / absurd
 * counts) and recompute the real totals. Used by the v13 chunked writer.
 */
export function validateMeshes(meshes: MeshData[]): {
  validMeshes: MeshData[];
  actualTotalVertices: number;
  actualTotalTriangles: number;
} {
  const validMeshes: MeshData[] = [];
  let actualTotalVertices = 0;
  let actualTotalTriangles = 0;

  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    const vertexCount = mesh.positions.length / 3;
    const indexCount = mesh.indices.length;

    // Sanity check: vertex/index counts should be reasonable
    if (vertexCount > MAX_VERTEX_COUNT || indexCount > MAX_INDEX_COUNT) {
      console.warn(`[cache:geometry] Skipping mesh ${i} (expressId=${mesh.expressId}): unreasonable counts`);
      continue;
    }

    // Verify array integrity (check for detached buffers or size mismatches)
    // Note: Some WASM-generated meshes may have mismatched array sizes - skip them
    if (mesh.normals.length !== mesh.positions.length) {
      console.warn(`[cache:geometry] Skipping mesh ${i} (expressId=${mesh.expressId}): normals/positions size mismatch (${mesh.normals.length} vs ${mesh.positions.length})`);
      continue;
    }

    validMeshes.push(mesh);
    actualTotalVertices += vertexCount;
    actualTotalTriangles += indexCount / 3;
  }

  return { validMeshes, actualTotalVertices, actualTotalTriangles };
}

/**
 * One current-version per-mesh record inside a v13+ chunk. Version 19
 * appends optional canonical appearance provenance after geometry arrays.
 */
export function writeMeshRecord(writer: BufferWriter, mesh: MeshData, pool?: AppearanceSourcePool): void {
  writer.writeUint32(mesh.expressId);

  const vertexCount = mesh.positions.length / 3;
  const indexCount = mesh.indices.length;

  writer.writeUint32(vertexCount);
  writer.writeUint32(indexCount);

  // Write color (RGBA)
  writer.writeFloat32(mesh.color[0]);
  writer.writeFloat32(mesh.color[1]);
  writer.writeFloat32(mesh.color[2]);
  writer.writeFloat32(mesh.color[3]);

  // Write ifcType (as string length + UTF-8 bytes)
  const ifcType = mesh.ifcType || '';
  writer.writeString(ifcType);

  // Write geometryClass (#957 Model/Types switch). Without this the viewer's
  // view-mode filter sees every cache-restored mesh as class 0: instanced
  // type-library geometry reappears in Model mode and the switch disappears.
  writer.writeUint8(mesh.geometryClass ?? 0);

  // Write the two DISJOINT source ids (v14+, #3199): the representation item
  // this piece was tessellated from, or the material layer it slices. Written
  // unconditionally as two u32 so the record stays fixed-shape.
  //
  // The absent sentinel is 0xFFFFFFFF, NOT 0, and the reason is worth keeping
  // straight because it CHANGED during #3199. `layers.rs` decodes a layer with
  // no material — an air gap — as `material_id = 0`, so 0 reached this writer
  // and the first draft encoded "absent" as 0, which silently dropped exactly
  // those layers: the valid-but-falsy trap.
  //
  // The producer now filters it instead (`with_style_metadata` maps a source id
  // of 0 to `None`, because `#0` is not a STEP instance name), so nothing
  // upstream emits 0 today. This layer does NOT rely on that: an encoding whose
  // absence marker is a value the domain can produce is one upstream change
  // away from being wrong again, and 0xFFFFFFFF costs nothing.
  writer.writeUint32(mesh.geometryItemId ?? ABSENT_SOURCE_ID);
  writer.writeUint32(mesh.materialId ?? ABSENT_SOURCE_ID);

  // Write per-element local-frame origin (v6+, 3×f64): world = origin +
  // position. [0,0,0] for absolute meshes. Without it a cache from a
  // local-frame load restores small local positions with no origin → every
  // element renders scattered near scene origin.
  writer.writeFloat64(mesh.origin ? mesh.origin[0] : 0);
  writer.writeFloat64(mesh.origin ? mesh.origin[1] : 0);
  writer.writeFloat64(mesh.origin ? mesh.origin[2] : 0);

  // Write geometry arrays
  writer.writeTypedArray(mesh.positions);
  writer.writeTypedArray(mesh.normals);
  writer.writeTypedArray(mesh.indices);
  writeProvenance(writer, mesh, pool);
  writeFinish(writer, mesh);
}

/** Bytes of the v22 finish trailer every mesh record ends with. */
export const MESH_FINISH_BYTES = 8;

/** IFC-authored finish (v22+, #5582): metallic, roughness as f32; NaN = absent. */
function writeFinish(writer: BufferWriter, mesh: MeshData): void {
  writer.writeFloat32(mesh.material?.metallic ?? Number.NaN);
  writer.writeFloat32(mesh.material?.roughness ?? Number.NaN);
}

function readFinish(reader: BufferReader, mesh: MeshData): void {
  const metallic = reader.readFloat32();
  const roughness = reader.readFloat32();
  // Tested for finiteness, not truthiness: 0 is a real authored value.
  if (!Number.isFinite(metallic) && !Number.isFinite(roughness)) return;
  mesh.material = {
    ...(Number.isFinite(metallic) ? { metallic } : {}),
    ...(Number.isFinite(roughness) ? { roughness } : {}),
  };
}

/** Exact serialized size of one per-mesh record, for chunk byte budgeting. */
export function meshRecordByteLength(mesh: MeshData, pool?: AppearanceSourcePool): number {
  const ifcTypeBytes = mesh.ifcType ? new TextEncoder().encode(mesh.ifcType).length : 0;
  return (
    4 + 4 + 4 +            // expressId, vertexCount, indexCount
    16 +                   // color f32x4
    4 + ifcTypeBytes +     // ifcType string
    1 +                    // geometryClass
    8 +                    // geometryItemId + materialId u32x2 (v14+)
    24 +                   // origin f64x3
    MESH_FINISH_BYTES +    // finish metallic + roughness f32x2 (v22+)
    mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength + provenanceByteLength(mesh, pool)
  );
}

/** Absent marker for the v14 source ids. Not 0 — `layers.rs` uses 0 for a
 *  material-free layer, so 0 is a real value (#3199). No STEP express id can
 *  reach 0xFFFFFFFF. */
const ABSENT_SOURCE_ID = 0xffffffff;

// Maximum reasonable values for sanity checking
const MAX_VERTEX_COUNT = 100_000_000; // 100M vertices max per mesh
const MAX_INDEX_COUNT = 300_000_000; // 300M indices max per mesh

/** IEEE-754 single-precision: a value is NaN or ±Infinity exactly when its
 *  8 exponent bits are all set, regardless of sign or mantissa. */
const FLOAT32_EXPONENT_MASK = 0x7f800000;

/**
 * Throw if any value in a decoded vertex-data array is non-finite (NaN or
 * ±Infinity). A legitimately-produced mesh never contains one (the WASM
 * geometry pipeline does not emit NaN/Infinity vertices), so a hit here means
 * corrupted or adversarial cache bytes, not a valid-but-unusual model.
 *
 * Checked via the raw bit pattern (a `Uint32Array` VIEW over the same buffer,
 * no copy) rather than `Number.isFinite(values[i])` or a chain of
 * `v !== v || v === Infinity || v === -Infinity` float comparisons: this
 * runs on every cache read's hot path (once per mesh, over every
 * position/normal float). Measured on a real 5,927-mesh/473K-vertex fixture
 * (dental_clinic.ifc, `pnpm --filter @ifc-lite/cache exec node` a throwaway
 * write+read harness, 20 iterations after 4 warmup reads): the bitwise
 * exponent test was the fastest of the three forms tried, but a full linear
 * scan of every position/normal float still measured ~15-20% over an
 * unguarded read's ~30ms baseline for this fixture (see the changeset for
 * the exact before/after numbers). Kept despite the cost: it is the only
 * guard in this package that closes a mis-parse (not just a bounds/shape)
 * class of corruption, and the viewer's cache-restore path already falls
 * back to a fresh parse on any reader throw (see `readMeshRecord`'s callers).
 */
function assertFiniteVertexData(
  values: Float32Array,
  field: 'positions' | 'normals',
  meshIndex: number,
  expressId: number,
): void {
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  for (let i = 0; i < bits.length; i++) {
    if ((bits[i] & FLOAT32_EXPONENT_MASK) === FLOAT32_EXPONENT_MASK) {
      throw new Error(
        `Invalid cache: mesh ${meshIndex} (expressId=${expressId}) has a non-finite value ` +
          `(${values[i]}) in ${field}[${i}]. Cache may be corrupted.`,
      );
    }
  }
}

/** Read one per-mesh record (see writeMeshRecord for the layout). */
export function readMeshRecord(reader: BufferReader, version: number, meshIndex: number = 0, pool?: readonly Uint32Array[]): MeshData {
  const expressId = reader.readUint32();
  const vertexCount = reader.readUint32();
  const indexCount = reader.readUint32();

  // Sanity check vertex/index counts
  if (vertexCount > MAX_VERTEX_COUNT) {
    throw new Error(`Invalid cache: vertexCount ${vertexCount} exceeds maximum ${MAX_VERTEX_COUNT} at mesh ${meshIndex}. Cache may be corrupted or from incompatible version.`);
  }
  if (indexCount > MAX_INDEX_COUNT) {
    throw new Error(`Invalid cache: indexCount ${indexCount} exceeds maximum ${MAX_INDEX_COUNT} at mesh ${meshIndex}. Cache may be corrupted or from incompatible version.`);
  }

  const color: [number, number, number, number] = [
    reader.readFloat32(),
    reader.readFloat32(),
    reader.readFloat32(),
    reader.readFloat32(),
  ];

  // Read ifcType (only in version 2+)
  let ifcType: string | undefined = undefined;
  if (version >= 2) {
    ifcType = reader.readString() || undefined;
  }

  // Read geometryClass (version 5+) — the Model/Types view-switch tag.
  // Older caches default to 0 (occurrence); v4 entries are bypassed by the
  // viewer's bumped cache key, so they re-mesh fresh rather than load here.
  const geometryClass = version >= 5 ? reader.readUint8() : 0;

  // Read the two disjoint source ids (version 14+, #3199). See
  // ABSENT_SOURCE_ID for what "absent" is encoded as, and why it is not 0.
  // Older caches predate the fields entirely and leave both undefined, which is
  // the same state the runtime uses where the identity is genuinely merged away
  // -- so a v13 cache degrades to "unknown", never to a WRONG id.
  let geometryItemId: number | undefined;
  let materialId: number | undefined;
  if (version >= 14) {
    const gid = reader.readUint32();
    const mid = reader.readUint32();
    // Compared against the sentinel, never for truthiness: 0 is a real
    // material-layer id (an air gap) and must survive the round trip.
    if (gid !== ABSENT_SOURCE_ID) geometryItemId = gid;
    if (mid !== ABSENT_SOURCE_ID) materialId = mid;
  }

  // Read per-element local-frame origin (version 6+); world = origin + position.
  let origin: [number, number, number] | undefined;
  if (version >= 6) {
    const ox = reader.readFloat64();
    const oy = reader.readFloat64();
    const oz = reader.readFloat64();
    if (ox || oy || oz) origin = [ox, oy, oz];
  }

  const positions = reader.readFloat32Array(vertexCount * 3);
  const normals = reader.readFloat32Array(vertexCount * 3);
  const indices = reader.readUint32Array(indexCount);

  // Reject a NaN/Infinity-bombed vertex region instead of letting it flow
  // downstream unfiltered. Structural guards elsewhere in this package (the
  // chunk directory's contiguity check, string-offset monotonicity, row-index
  // bounds) all validate that declared SHAPES are self-consistent, but none of
  // them constrain the numeric DOMAIN of a position/normal float once its
  // slot is legitimately in range -- a byte-flip that lands inside the
  // position array itself passes every existing check and decodes as a
  // syntactically valid, semantically poisoned float. Left unchecked, that
  // reaches `packages/spatial`'s BVH (a NaN aggregate bound silently hides
  // valid SIBLING meshes under the same node until #3547's NaN-safe compare)
  // and the renderer/picking path, neither of which re-validates cache input.
  // Failing here, at the boundary where untrusted bytes become a MeshData,
  // keeps that contract in one place instead of relying on every downstream
  // consumer to defend itself.
  assertFiniteVertexData(positions, 'positions', meshIndex, expressId);
  assertFiniteVertexData(normals, 'normals', meshIndex, expressId);

  const mesh: MeshData = {
    expressId,
    positions,
    normals,
    indices,
    color,
    ifcType,
    geometryClass,
    // Spread only the one that is set, so the disjointness the format preserves
    // survives into the object a consumer reads (#3199).
    ...(geometryItemId !== undefined ? { geometryItemId } : {}),
    ...(materialId !== undefined ? { materialId } : {}),
    ...(origin ? { origin } : {}),
  };
  if (version >= 19) readProvenance(reader, mesh, pool);
  if (version >= 22) readFinish(reader, mesh);
  return mesh;
}
