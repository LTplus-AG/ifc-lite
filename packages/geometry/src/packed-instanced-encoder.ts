/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript writer for INSTANCED geometry shards ("IFNS").
 *
 * The local parse gets its shards from the Rust encoder
 * (`rust/geometry/src/instancing/wire.rs`). A producer that already holds
 * shared geometry in JavaScript, such as a server-processed model whose Parquet
 * mesh rows name one shared vertex block, writes the same bytes here, so its
 * occurrences reach the renderer through the same queue, drain and upload as a
 * local parse's.
 *
 * The layout is the one `packed-instanced-decoder.ts` documents. The version
 * and stride rules match the Rust encoder: a base-record shard is v1 (stride
 * word 0), a shard with any item id is v2 (stride 92), and a shard with any
 * authored finish is v3 (stride 100, item id included). An `IFNL` key trailer
 * is appended when any template names a key.
 */

import { INSTANCED_KEY_TRAILER_MAGIC, INSTANCED_SHARD_MAGIC } from './packed-instanced-decoder.js';

const HEADER_WORDS = 8;
const TEMPLATE_RECORD_BYTES = 48;
const BASE_STRIDE = 88;
const ITEM_ID_STRIDE = 92;
const FINISH_STRIDE = 100;

/** One unique geometry, written once. */
export interface InstancedShardTemplateInput {
  positions: Float32Array;
  normals: Float32Array;
  /** Local to this template's vertices (0-based). */
  indices: Uint32Array;
  /** f64 template origin; world vertex = transform · (origin + position). */
  origin: readonly [number, number, number];
  /** Model-wide template key as two u32 words (hi, lo); `[0, 0]` or absent means unkeyed. */
  key?: readonly [number, number];
}

/** One occurrence of a template. */
export interface InstancedShardInstanceInput {
  templateIndex: number;
  entityId: number;
  color: readonly [number, number, number, number];
  /** Row-major 4×4 in the shard's native IFC Z-up frame (the renderer applies the Y-up swap). */
  transform: ArrayLike<number>;
  itemId?: number;
  metallic?: number;
  roughness?: number;
}

/** Encode templates and occurrences into IFNS bytes that `decodeInstancedShard` reads back. */
export function encodeInstancedShard(
  templates: readonly InstancedShardTemplateInput[],
  instances: readonly InstancedShardInstanceInput[],
): ArrayBuffer {
  const carriesFinish = instances.some((i) => i.metallic !== undefined || i.roughness !== undefined);
  const carriesItemId = carriesFinish || instances.some((i) => i.itemId !== undefined && i.itemId !== 0);
  const [version, stride, strideWord] = carriesFinish
    ? [3, FINISH_STRIDE, FINISH_STRIDE]
    : carriesItemId ? [2, ITEM_ID_STRIDE, ITEM_ID_STRIDE] : [1, BASE_STRIDE, 0];
  const keyed = templates.some((t) => t.key !== undefined && (t.key[0] !== 0 || t.key[1] !== 0));

  let positionsLen = 0, normalsLen = 0, indicesLen = 0;
  for (const t of templates) {
    positionsLen += t.positions.length;
    normalsLen += t.normals.length;
    indicesLen += t.indices.length;
  }
  const templateTable = HEADER_WORDS * 4;
  const instanceTable = templateTable + templates.length * TEMPLATE_RECORD_BYTES;
  const data = instanceTable + instances.length * stride;
  const poolsEnd = data + (positionsLen + normalsLen + indicesLen) * 4;
  const total = poolsEnd + (keyed ? 8 + templates.length * 8 : 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);

  const header = [INSTANCED_SHARD_MAGIC, version, templates.length, instances.length, positionsLen, normalsLen, indicesLen, strideWord];
  for (let i = 0; i < HEADER_WORDS; i++) view.setUint32(i * 4, header[i], true);

  // Pools are 4-byte aligned (every record above is a multiple of 4), so typed views can write them.
  const positions = new Float32Array(buffer, data, positionsLen);
  const normals = new Float32Array(buffer, data + positionsLen * 4, normalsLen);
  const indices = new Uint32Array(buffer, data + (positionsLen + normalsLen) * 4, indicesLen);
  let posOff = 0, nrmOff = 0, idxOff = 0;
  templates.forEach((t, i) => {
    const base = templateTable + i * TEMPLATE_RECORD_BYTES;
    const words = [posOff, t.positions.length, nrmOff, t.normals.length, idxOff, t.indices.length];
    for (let k = 0; k < 6; k++) view.setUint32(base + k * 4, words[k], true);
    for (let k = 0; k < 3; k++) view.setFloat64(base + 24 + k * 8, t.origin[k], true);
    positions.set(t.positions, posOff);
    normals.set(t.normals, nrmOff);
    indices.set(t.indices, idxOff);
    posOff += t.positions.length;
    nrmOff += t.normals.length;
    idxOff += t.indices.length;
  });

  instances.forEach((inst, i) => {
    if (inst.templateIndex < 0 || inst.templateIndex >= templates.length) {
      throw new Error(`Instanced shard: instance ${i} names template ${inst.templateIndex} of ${templates.length}`);
    }
    if (inst.transform.length !== 16) throw new Error(`Instanced shard: instance ${i} transform is not 4×4`);
    const base = instanceTable + i * stride;
    view.setUint32(base, inst.templateIndex, true);
    view.setUint32(base + 4, inst.entityId, true);
    for (let k = 0; k < 4; k++) view.setFloat32(base + 8 + k * 4, inst.color[k], true);
    for (let k = 0; k < 16; k++) view.setFloat32(base + 24 + k * 4, inst.transform[k], true);
    if (carriesItemId) view.setUint32(base + BASE_STRIDE, inst.itemId ?? 0, true);
    if (carriesFinish) {
      view.setFloat32(base + ITEM_ID_STRIDE, inst.metallic ?? NaN, true);
      view.setFloat32(base + ITEM_ID_STRIDE + 4, inst.roughness ?? NaN, true);
    }
  });

  if (keyed) {
    view.setUint32(poolsEnd, INSTANCED_KEY_TRAILER_MAGIC, true);
    view.setUint32(poolsEnd + 4, templates.length, true);
    templates.forEach((t, i) => {
      view.setUint32(poolsEnd + 8 + i * 8, t.key?.[0] ?? 0, true);
      view.setUint32(poolsEnd + 12 + i * 8, t.key?.[1] ?? 0, true);
    });
  }
  return buffer;
}
