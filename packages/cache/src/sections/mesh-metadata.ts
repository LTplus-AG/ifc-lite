/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * v25 per-mesh optional metadata trailer (#7350).
 *
 * The fresh WASM load captures three optional per-piece values that every
 * earlier record layout silently dropped, so a cache hit served the same
 * meshes without them:
 *   - `localBounds`: pre-placement object-space AABB (#1474), f32 at the source.
 *   - `localToWorld`: resolved IfcLocalPlacement chain, row-major 4x4 f64 (#1474).
 *   - `shadingColor`: authored SurfaceColour when distinct from `color`, f32.
 *
 * Layout: one presence-flags byte, then each present payload in flag order.
 * Absent stays absent: nothing is derived from `origin`, chunk AABBs or
 * `color`. Bounds and shading colour are f32 because the WASM getters return
 * f32 (`zero_copy/mesh.rs`), so the round trip is exact for every value the
 * pipeline produces; the placement matrix keeps its f64 precision.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { BufferReader, BufferWriter } from '../utils/buffer-utils.js';

const SHADING_COLOR = 1;
const LOCAL_BOUNDS = 2;
const LOCAL_TO_WORLD = 4;
const KNOWN_FLAGS = SHADING_COLOR | LOCAL_BOUNDS | LOCAL_TO_WORLD;

/** Bytes of the v25 trailer when the mesh carries none of the fields. */
export const MESH_METADATA_ABSENT_BYTES = 1;

function flagsOf(mesh: MeshData): number {
  return (mesh.shadingColor?.length === 4 ? SHADING_COLOR : 0) |
    (mesh.localBounds?.min?.length === 3 && mesh.localBounds.max?.length === 3 ? LOCAL_BOUNDS : 0) |
    (mesh.localToWorld?.length === 16 ? LOCAL_TO_WORLD : 0);
}

export function meshMetadataByteLength(mesh: MeshData): number {
  const flags = flagsOf(mesh);
  return 1 +
    (flags & SHADING_COLOR ? 16 : 0) +
    (flags & LOCAL_BOUNDS ? 24 : 0) +
    (flags & LOCAL_TO_WORLD ? 128 : 0);
}

export function writeMeshMetadata(writer: BufferWriter, mesh: MeshData): void {
  const flags = flagsOf(mesh);
  writer.writeUint8(flags);
  if (flags & SHADING_COLOR) for (const value of mesh.shadingColor!) writer.writeFloat32(value);
  if (flags & LOCAL_BOUNDS) {
    for (const value of mesh.localBounds!.min) writer.writeFloat32(value);
    for (const value of mesh.localBounds!.max) writer.writeFloat32(value);
  }
  if (flags & LOCAL_TO_WORLD) for (const value of mesh.localToWorld!) writer.writeFloat64(value);
}

function readVec3(reader: BufferReader): [number, number, number] {
  return [reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
}

export function readMeshMetadata(reader: BufferReader, mesh: MeshData): void {
  const flags = reader.readUint8();
  if (flags & ~KNOWN_FLAGS) {
    throw new Error(`Invalid cache: mesh ${mesh.expressId} has unknown metadata flags 0x${flags.toString(16)}; rebuild this cache.`);
  }
  if (flags & SHADING_COLOR) {
    mesh.shadingColor = [reader.readFloat32(), reader.readFloat32(), reader.readFloat32(), reader.readFloat32()];
  }
  if (flags & LOCAL_BOUNDS) {
    const min = readVec3(reader);
    mesh.localBounds = { min, max: readVec3(reader) };
  }
  if (flags & LOCAL_TO_WORLD) {
    const matrix = new Array<number>(16);
    for (let i = 0; i < 16; i++) matrix[i] = reader.readFloat64();
    mesh.localToWorld = matrix;
  }
}
