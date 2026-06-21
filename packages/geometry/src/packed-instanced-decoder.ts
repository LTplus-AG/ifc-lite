/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Binary format parsing for INSTANCED geometry shards ("IFNS").
 *
 * Mirrors the Rust encoder in `rust/geometry/src/instancing.rs`
 * (`encode_instanced` / `decode_instanced`). Carries each UNIQUE template
 * geometry once + a per-occurrence instance row (transform + entity id + colour),
 * so the renderer can upload a template once and `drawIndexed(.., instanceCount)`.
 *
 * Layout (little-endian):
 *   Header (8 × uint32): magic, version, templateCount, instanceCount,
 *                        positionsLen, normalsLen, indicesLen, reserved
 *   Template table (templateCount × 48 bytes): posOff, posLen, nrmOff, nrmLen,
 *                        idxOff, idxLen (6 × uint32) then originX, originY,
 *                        originZ (3 × float64)
 *   Instance table (instanceCount × 88 bytes): templateIndex (uint32),
 *                        entityId (uint32), colour (4 × float32),
 *                        transform (16 × float32, row-major)
 *   Data: positions (Float32 × positionsLen), normals (Float32 × normalsLen),
 *         indices (Uint32 × indicesLen). Offsets/lengths are ELEMENT counts;
 *         indices stay local to each template's vertex range (0-based).
 */

import { toArrayBuffer } from './packed-geometry-decoder.js';

/** `"IFNS"` little-endian — must match `INSTANCED_MAGIC` in instancing.rs. */
export const INSTANCED_SHARD_MAGIC = 0x4946_4e53;
/** Must match `INSTANCED_VERSION` in instancing.rs. */
export const INSTANCED_SHARD_VERSION = 1;

const HEADER_WORDS = 8;
const TEMPLATE_RECORD_BYTES = 48;
const INSTANCE_RECORD_BYTES = 88;

/** A unique geometry decoded from an instanced shard (uploaded once). */
export interface DecodedInstancedTemplate {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per-template local origin (f64); world vertex = transform · (origin + position). */
  origin: [number, number, number];
}

/** One occurrence of a decoded template. */
export interface DecodedInstance {
  templateIndex: number;
  entityId: number;
  /** RGBA in 0–1. */
  color: [number, number, number, number];
  /** Row-major mat4 mapping the template's world geometry onto this occurrence. */
  transform: Float32Array;
}

/** A decoded instanced shard. */
export interface DecodedInstancedShard {
  templates: DecodedInstancedTemplate[];
  instances: DecodedInstance[];
}

/** Whether a payload's leading magic marks it as an instanced ("IFNS") shard. */
export function isInstancedShard(payload: unknown): boolean {
  try {
    const buffer = toArrayBuffer(payload);
    if (buffer.byteLength < 4) return false;
    return new Uint32Array(buffer, 0, 1)[0] === INSTANCED_SHARD_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Decode an instanced ("IFNS") geometry shard. Throws on bad magic/version or a
 * truncated buffer.
 */
export function decodeInstancedShard(payload: unknown): DecodedInstancedShard {
  const buffer = toArrayBuffer(payload);
  if (buffer.byteLength < HEADER_WORDS * 4) {
    throw new Error('Instanced shard too small for header');
  }
  const header = new Uint32Array(buffer, 0, HEADER_WORDS);
  const [magic, version, templateCount, instanceCount, positionsLen, normalsLen, indicesLen] =
    header;
  if (magic !== INSTANCED_SHARD_MAGIC) {
    throw new Error('Invalid instanced shard magic');
  }
  if (version !== INSTANCED_SHARD_VERSION) {
    throw new Error(`Unsupported instanced shard version: ${version}`);
  }

  const templateTableOffset = HEADER_WORDS * 4;
  const instanceTableOffset = templateTableOffset + templateCount * TEMPLATE_RECORD_BYTES;
  const dataOffset = instanceTableOffset + instanceCount * INSTANCE_RECORD_BYTES;
  const positionsByteOffset = dataOffset;
  const normalsByteOffset = positionsByteOffset + positionsLen * 4;
  const indicesByteOffset = normalsByteOffset + normalsLen * 4;
  const expectedBytes = indicesByteOffset + indicesLen * 4;
  if (buffer.byteLength < expectedBytes) {
    throw new Error(
      `Instanced shard truncated: have ${buffer.byteLength}, need ${expectedBytes}`
    );
  }

  // Pooled data arrays (views into the shard buffer; sub-viewed per template).
  const positions = new Float32Array(buffer, positionsByteOffset, positionsLen);
  const normals = new Float32Array(buffer, normalsByteOffset, normalsLen);
  const indices = new Uint32Array(buffer, indicesByteOffset, indicesLen);

  const view = new DataView(buffer);

  const templates: DecodedInstancedTemplate[] = [];
  for (let t = 0; t < templateCount; t += 1) {
    const base = templateTableOffset + t * TEMPLATE_RECORD_BYTES;
    const posOff = view.getUint32(base, true);
    const posLen = view.getUint32(base + 4, true);
    const nrmOff = view.getUint32(base + 8, true);
    const nrmLen = view.getUint32(base + 12, true);
    const idxOff = view.getUint32(base + 16, true);
    const idxLen = view.getUint32(base + 20, true);
    const origin: [number, number, number] = [
      view.getFloat64(base + 24, true),
      view.getFloat64(base + 32, true),
      view.getFloat64(base + 40, true),
    ];
    // Validate each template's pool ranges before subarray — a malformed/wrapped
    // offset would otherwise silently clip (subarray saturates), yielding
    // truncated geometry indistinguishable from a real occurrence.
    if (
      posOff + posLen > positionsLen ||
      nrmOff + nrmLen > normalsLen ||
      idxOff + idxLen > indicesLen
    ) {
      throw new Error(`Instanced shard template ${t} pool offset out of bounds`);
    }
    templates.push({
      positions: positions.subarray(posOff, posOff + posLen),
      normals: normals.subarray(nrmOff, nrmOff + nrmLen),
      indices: indices.subarray(idxOff, idxOff + idxLen),
      origin,
    });
  }

  const instances: DecodedInstance[] = [];
  for (let i = 0; i < instanceCount; i += 1) {
    const base = instanceTableOffset + i * INSTANCE_RECORD_BYTES;
    const templateIndex = view.getUint32(base, true);
    if (templateIndex >= templates.length) {
      throw new Error(
        `Instanced shard instance ${i} references missing template ${templateIndex} (have ${templates.length})`,
      );
    }
    const entityId = view.getUint32(base + 4, true);
    const color: [number, number, number, number] = [
      view.getFloat32(base + 8, true),
      view.getFloat32(base + 12, true),
      view.getFloat32(base + 16, true),
      view.getFloat32(base + 20, true),
    ];
    const transform = new Float32Array(16);
    for (let k = 0; k < 16; k += 1) {
      transform[k] = view.getFloat32(base + 24 + k * 4, true);
    }
    instances.push({ templateIndex, entityId, color, transform });
  }

  return { templates, instances };
}
