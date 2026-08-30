/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Binary format parsing for INSTANCED geometry shards ("IFNS").
 *
 * Mirrors the Rust encoder in `rust/geometry/src/instancing/wire.rs`
 * (`encode_refs` / `decode_instanced`); the canonical spec these two statements
 * of the format both answer to lives at `rust/geometry/src/instancing/mod.rs`.
 * Carries each UNIQUE template geometry once + a per-occurrence instance row
 * (transform + entity id + colour), so the renderer can upload a template once
 * and `drawIndexed(.., instanceCount)`.
 *
 * Layout (little-endian):
 *   Header (8 × uint32): magic, version, templateCount, instanceCount,
 *                        positionsLen, normalsLen, indicesLen,
 *                        instanceStrideBytes
 *   Template table (templateCount × 48 bytes): posOff, posLen, nrmOff, nrmLen,
 *                        idxOff, idxLen (6 × uint32) then originX, originY,
 *                        originZ (3 × float64)
 *   Instance table (instanceCount × instanceStrideBytes): the 88-byte BASE
 *                        record — templateIndex (uint32), entityId (uint32),
 *                        colour (4 × float32), transform (16 × float32,
 *                        row-major) — then whatever trailing fields the stride
 *                        makes room for. Trailing field 1 is itemId (uint32) at
 *                        offset 88, so a shard carrying it declares a stride
 *                        of 92.
 *   Data: positions (Float32 × positionsLen), normals (Float32 × normalsLen),
 *         indices (Uint32 × indicesLen). Offsets/lengths are ELEMENT counts;
 *         indices stay local to each template's vertex range (0-based).
 *
 * VERSIONING: APPEND-ONLY FIELDS AND A STRIDE THE READER READS.
 *
 * Per-instance fields are APPEND-ONLY, in a fixed canonical order. A field is
 * never removed and never reordered, so a record is always the 88-byte base
 * followed by trailing fields 1..n in that order. Header word 7 carries the
 * instance record STRIDE IN BYTES, which is what tells a reader how many of
 * those trailing fields the shard in front of it actually has: it decodes the
 * ones it knows and SKIPS the rest by stepping the stride.
 *
 * Word 7 was a literal `0` read by nobody in v1, and #2985 first spent it as a
 * FLAGS word. That was wrong. A decoder must REJECT a flag bit it does not
 * know, because an unknown bit changes the stride unknowably and a mis-strided
 * read yields plausible garbage rather than an error — so flags buy no forward
 * compatibility at all over the version word they duplicate. A stride the
 * decoder READS buys exactly that: a v3 shard that appends a field is still
 * readable here, at every known field's fixed offset, stepping over the tail.
 *
 * So the version gate is PERMISSIVE where it can be:
 *   - version 1 (or word 7 === 0): stride 88, no trailing fields. v1 wrote a
 *     literal 0 there and 0 is not a legal stride, so both readings agree. That
 *     is what lets a v1 shard already persisted verbatim in a cache
 *     (`@ifc-lite/cache`'s InstancedShards section stores the raw bytes and does
 *     not re-encode) keep loading. It is also what the Rust encoder writes when
 *     no occurrence names an item, so a base-record shard from THIS build is
 *     byte-identical to a v1 one and an older build can still read it.
 *   - any version >= 2 whose stride is READABLE and VALID (>= the 88-byte base,
 *     and small enough that the instance table it implies fits the buffer):
 *     decode the trailing fields this build knows, ignore the rest. A stride
 *     must also be 4-BYTE ALIGNED: every field on this wire is 4 bytes, and the
 *     pooled data views below cannot be constructed at an unaligned offset.
 * Version 0 is refused — it is not a version.
 *
 * Permissiveness here does NOT make the cache key safe in the other direction.
 * A bundle from before #2985 refuses any version but 1 outright, so
 * `@ifc-lite/cache`'s FORMAT_VERSION moves 15 → 16 with this change to stop such
 * a bundle matching a key whose stored shards are v2 and silently dropping every
 * instanced occurrence.
 */

import { toArrayBuffer } from './packed-geometry-decoder.js';

/** `"IFNS"` little-endian — must match `INSTANCED_MAGIC` in wire.rs. */
export const INSTANCED_SHARD_MAGIC = 0x4946_4e53;
/** The HIGHEST version the Rust encoder writes — for a record carrying the
 *  trailing itemId; must match `INSTANCED_VERSION` in wire.rs. The encoder still
 *  writes 1 for a base-record shard. Neither is a ceiling on what this decoder
 *  reads — see the versioning note above. */
export const INSTANCED_SHARD_VERSION = 2;

const HEADER_WORDS = 8;
const TEMPLATE_RECORD_BYTES = 48;
/** Instance record bytes BEFORE any trailing field: templateIndex(4) +
 *  entityId(4) + colour(16) + transform(64). Also a v1 shard's stride, and the
 *  floor every declared stride is validated against. */
const INSTANCE_RECORD_BASE_BYTES = 88;
/** Byte offset of trailing field 1, itemId, within an instance record. */
const INSTANCE_ITEM_ID_OFFSET = INSTANCE_RECORD_BASE_BYTES;
/** Stride of a record carrying trailing field 1 (itemId) and nothing after it. */
const INSTANCE_RECORD_ITEM_ID_BYTES = INSTANCE_ITEM_ID_OFFSET + 4;

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
  /** The `IfcRepresentationItem` this occurrence's geometry was tessellated
   *  from, so a host can drill from a rendered instanced piece back to the
   *  entity in the IFC source. Undefined when the shard's stride declares no
   *  trailing item-id field (a v1 shard, or a model whose producer named no
   *  item at all) and when this record's own id is the `0` sentinel. */
  itemId?: number;
}

/** A decoded instanced shard. */
export interface DecodedInstancedShard {
  templates: DecodedInstancedTemplate[];
  instances: DecodedInstance[];
  /** Whether the declared instance stride reaches the trailing itemId field.
   *  REQUIRED rather than optional on purpose: it is what a consumer keys the
   *  per-occurrence itemId allocation off (`prepareInstancedRender`), and an
   *  omitted flag would read as "no ids" and silently drop them — the absence-
   *  looks-like-success shape this whole change is about. The encoder derives
   *  it from the data, so `false` means no occurrence in the shard names an
   *  item, not merely that this build cannot see them. */
  carriesItemIds: boolean;
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
  // PERMISSIVE on version, STRICT on stride. Refusing a version above the one
  // the encoder writes would refuse exactly the shards forward compatibility is
  // for: a v3 that APPENDS a trailing field is fully readable here, because
  // every field this build knows sits at a fixed offset in the base record and
  // the declared stride steps over the tail it does not know. It would also
  // have refused the v1 shards already sitting in caches, which store IFNS
  // bytes verbatim rather than re-encoding. Version 0 is not a version.
  if (version === 0) {
    throw new Error(`Unsupported instanced shard version: ${version}`);
  }
  // Word 7 is `reserved` in v1 and the instance record STRIDE from v2 on. v1
  // wrote a literal 0 there, which is not a legal stride, so both readings of a
  // v1 shard land on the 88-byte base record.
  const declaredStride = version >= 2 ? header[7] : 0;
  const instanceRecordStride =
    declaredStride === 0 ? INSTANCE_RECORD_BASE_BYTES : declaredStride;
  // A stride below the base is not a shorter record, it is a corrupt header:
  // the base fields are not optional. Reading at it would slice each record out
  // of its predecessor's transform and yield plausible garbage.
  if (instanceRecordStride < INSTANCE_RECORD_BASE_BYTES) {
    throw new Error(
      `Instanced shard instance stride ${instanceRecordStride} is below the ${INSTANCE_RECORD_BASE_BYTES}-byte base record`
    );
  }
  // An UNALIGNED stride is refused for the same reason, and the Rust decoder
  // refuses it too: every field on this wire is 4 bytes, so a record boundary
  // off a 4-byte multiple names no field. This side cannot even attempt one —
  // the data pools below are Float32Array/Uint32Array views onto the shard
  // buffer at `dataOffset`, and an odd stride pushes that offset off 4 (stride
  // 90 with one template and one instance lands on 170), where the view
  // constructor throws an opaque RangeError instead of this format error. Rust
  // reads the identical bytes through byte slices and used to accept them, so
  // without this the two statements of the format disagreed on exactly the
  // shards the permissive-version rule promises to read.
  if (instanceRecordStride % 4 !== 0) {
    throw new Error(
      `Instanced shard instance stride ${instanceRecordStride} is not a multiple of 4`
    );
  }
  const carriesItemIds = instanceRecordStride >= INSTANCE_RECORD_ITEM_ID_BYTES;

  const templateTableOffset = HEADER_WORDS * 4;
  const instanceTableOffset = templateTableOffset + templateCount * TEMPLATE_RECORD_BYTES;
  const dataOffset = instanceTableOffset + instanceCount * instanceRecordStride;
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
    const base = instanceTableOffset + i * instanceRecordStride;
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
    // Trailing field 1, present only when the stride makes room for it; a
    // stride that reaches further still carries fields appended by a newer
    // producer, skipped rather than refused. 0 is the producer's "no item"
    // sentinel (STEP names start at #1), and a shard without the field has none
    // at all — both surface as absent, so a consumer cannot tell an absent id
    // apart from a fabricated #0.
    const itemId = carriesItemIds ? view.getUint32(base + INSTANCE_ITEM_ID_OFFSET, true) : 0;
    // One object SHAPE for every instance. A conditional spread allocates a
    // throwaway object per occurrence and gives DecodedInstance two hidden
    // classes, which the consumer then reads in a tight loop
    // (instanced-render.ts). `undefined` satisfies `itemId?: number` and
    // allocates nothing.
    instances.push({
      templateIndex,
      entityId,
      color,
      transform,
      itemId: itemId !== 0 ? itemId : undefined,
    });
  }

  return { templates, instances, carriesItemIds };
}
