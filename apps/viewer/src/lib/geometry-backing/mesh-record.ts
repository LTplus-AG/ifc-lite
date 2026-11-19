/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live-geometry backing records: a complete, structured-clone-safe image of one
 * `MeshData` for the browser-storage backing of a model whose CPU arrays may be
 * released. Deliberately NOT the persistent cache codec (`writeMeshRecord`),
 * which drops `entityIds`, `uvs`, textures and `modelIndex` and narrows colours
 * to f32: a backing that is the sole copy may lose nothing.
 *
 * - Every typed array is copied to its own exact-length buffer. Structured
 *   clone serialises a view's WHOLE backing buffer, so storing a view into a
 *   worker arena directly would persist the entire arena once per mesh.
 * - Object identity inside one mesh is preserved through slots (the
 *   appearance fence `appearanceSource.indices === indices` is an identity
 *   check in the renderer, not a value comparison).
 * - Canonical `sourceIndices` shared by the pieces of one representation item
 *   are pooled by object identity across records, so a split item stores its
 *   canonical topology once rather than once per piece and chunk.
 * - `textureBitmap` (an ImageBitmap) is not assumed persistable. It is kept by
 *   `textureRef.textureId` in memory and re-attached on decode; a missing image
 *   is an error, never a silently untextured mesh.
 * - Unknown runtime fields are refused, so a later `MeshData` field cannot be
 *   dropped without this codec being updated (`MESH_FIELDS` must name every
 *   key of `MeshData` at compile time).
 */

import type { MeshData } from '@ifc-lite/geometry';

type FieldKind = 'scalar' | 'array' | 'appearance' | 'texture' | 'bitmap';

/** Exhaustive at compile time: adding a `MeshData` field fails `satisfies`. */
const MESH_FIELDS = {
  expressId: 'scalar', ifcType: 'scalar', modelIndex: 'scalar', positions: 'array', normals: 'array',
  indices: 'array', appearanceSource: 'appearance', color: 'scalar', shadingColor: 'scalar',
  entityIds: 'array', geometryItemId: 'scalar', materialId: 'scalar', material: 'scalar', uvs: 'array',
  texture: 'texture', textureRef: 'scalar', textureBitmap: 'bitmap', geometryHash: 'scalar',
  geometryAabb: 'scalar', geometryVolume: 'scalar', geometryClass: 'scalar', origin: 'scalar',
  occurrenceKey: 'scalar', localBounds: 'scalar', localToWorld: 'scalar',
} as const satisfies Record<keyof MeshData, FieldKind>;

type ArrayField = 'positions' | 'normals' | 'indices' | 'entityIds' | 'uvs';
const ARRAY_FIELDS: readonly ArrayField[] = ['positions', 'normals', 'indices', 'entityIds', 'uvs'];
type StoredArray = Float32Array | Uint32Array | Uint8Array;

export interface MeshRecord {
  /** Scalar and plain-object fields, cloned verbatim (f64 colours, bigint hash). */
  fields: Record<string, unknown>;
  /** Standalone exact copies; slots reference them by position. */
  arrays: StoredArray[];
  slots: Partial<Record<ArrayField | 'textureRgba', number>>;
  texture?: { width: number; height: number; repeatS: boolean; repeatT: boolean };
  appearance?: {
    kind: 'canonical-item';
    fence: number;
    /** A pooled source id, or a slot of this record (e.g. sourceIndices === indices). */
    source: { pooled: number } | { slot: number };
    corners?: number;
  };
  /** Present when the live mesh carried a main-thread ImageBitmap. */
  bitmapTextureId?: number;
}

/** A pooled canonical source the caller must persist with the first record using it. */
export interface PendingSource { id: number; indices: Uint32Array }

export class UnsupportedBackingFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedBackingFieldError';
  }
}

/** Assigns stable ids to canonical source arrays by object identity, weakly. */
export class SourcePool {
  private readonly ids = new WeakMap<Uint32Array, number>();
  private next = 0;

  /** The id and, the first time an array is seen, the copy to persist. */
  intern(source: Uint32Array): { id: number; pending?: PendingSource } {
    const known = this.ids.get(source);
    if (known !== undefined) return { id: known };
    const id = this.next++;
    this.ids.set(source, id);
    return { id, pending: { id, indices: source.slice() } };
  }
}

/** Main-thread images keyed by texture id; ImageBitmap is not persisted. */
export class TextureBitmapTable {
  private readonly bitmaps = new Map<number, ImageBitmap>();

  remember(textureId: number, bitmap: ImageBitmap): void {
    const prior = this.bitmaps.get(textureId);
    if (prior && prior !== bitmap) {
      throw new UnsupportedBackingFieldError(`Texture ${textureId} carries two different images`);
    }
    this.bitmaps.set(textureId, bitmap);
  }

  get(textureId: number): ImageBitmap | undefined { return this.bitmaps.get(textureId); }
  get size(): number { return this.bitmaps.size; }
}

export interface EncodedMesh {
  record: MeshRecord;
  /** Sources first interned by this record. */
  sources: PendingSource[];
  /** Stored bytes of the record's own arrays plus its new sources. */
  bytes: number;
}

function copyOf<T extends StoredArray>(view: T): T {
  // `slice` always yields a fresh, non-shared, exact-length buffer.
  return view.slice() as T;
}

export function encodeMeshRecord(mesh: MeshData, pool: SourcePool, bitmaps: TextureBitmapTable): EncodedMesh {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(mesh)) {
    if (!Object.prototype.hasOwnProperty.call(MESH_FIELDS, key)) {
      throw new UnsupportedBackingFieldError(`Mesh ${mesh.expressId} carries unknown field "${key}"`);
    }
    const value = (mesh as unknown as Record<string, unknown>)[key];
    if (value !== undefined && MESH_FIELDS[key as keyof MeshData] === 'scalar') fields[key] = value;
  }
  const arrays: StoredArray[] = [];
  const slotOf = new Map<StoredArray, number>();
  const slot = (view: StoredArray): number => {
    const known = slotOf.get(view);
    if (known !== undefined) return known;
    arrays.push(copyOf(view));
    slotOf.set(view, arrays.length - 1);
    return arrays.length - 1;
  };
  const slots: MeshRecord['slots'] = {};
  for (const field of ARRAY_FIELDS) {
    const view = mesh[field];
    if (view !== undefined) slots[field] = slot(view);
  }
  // Snapshot mutable tuples and metadata now, rather than when a queued IDB
  // transaction eventually starts after the producer has edited the mesh.
  const record: MeshRecord = { fields: structuredClone(fields), arrays, slots };
  if (mesh.texture) {
    const { rgba, width, height, repeatS, repeatT } = mesh.texture;
    slots.textureRgba = slot(rgba);
    record.texture = { width, height, repeatS, repeatT };
  }
  const sources: PendingSource[] = [];
  const appearance = mesh.appearanceSource;
  if (appearance) {
    if (appearance.kind !== 'canonical-item') {
      throw new UnsupportedBackingFieldError(`Mesh ${mesh.expressId} has appearance kind ${String(appearance.kind)}`);
    }
    // A source aliasing an array of this mesh stays a slot; otherwise pool it.
    const local = slotOf.get(appearance.sourceIndices);
    let source: { pooled: number } | { slot: number };
    if (local !== undefined) source = { slot: local };
    else {
      const interned = pool.intern(appearance.sourceIndices);
      if (interned.pending) sources.push(interned.pending);
      source = { pooled: interned.id };
    }
    record.appearance = {
      kind: 'canonical-item', fence: slot(appearance.indices), source,
      ...(appearance.cornerIndices !== undefined ? { corners: slot(appearance.cornerIndices) } : {}),
    };
  }
  if (mesh.textureBitmap !== undefined) {
    if (!mesh.textureRef) {
      throw new UnsupportedBackingFieldError(`Mesh ${mesh.expressId} has an image without a texture reference`);
    }
    bitmaps.remember(mesh.textureRef.textureId, mesh.textureBitmap);
    record.bitmapTextureId = mesh.textureRef.textureId;
  }
  let bytes = 0;
  for (const array of arrays) bytes += array.byteLength;
  for (const pending of sources) bytes += pending.indices.byteLength;
  return { record, sources, bytes };
}

export interface DecodeContext {
  source(id: number): Uint32Array;
  bitmap(textureId: number): ImageBitmap | undefined;
}

function expectArray<T extends StoredArray>(record: MeshRecord, index: number | undefined, type: { new(n: number): T }, what: string): T {
  const view = index === undefined ? undefined : record.arrays[index];
  if (!(view instanceof type)) throw new TypeError(`Backing record is missing its ${what}`);
  return view;
}

/** Rebuild the live mesh shape, including identity relations and images. */
export function decodeMeshRecord(record: MeshRecord, context: DecodeContext): MeshData {
  const mesh = { ...record.fields } as unknown as MeshData;
  const { slots } = record;
  mesh.positions = expectArray(record, slots.positions, Float32Array, 'positions');
  mesh.normals = expectArray(record, slots.normals, Float32Array, 'normals');
  mesh.indices = expectArray(record, slots.indices, Uint32Array, 'indices');
  if (slots.entityIds !== undefined) mesh.entityIds = expectArray(record, slots.entityIds, Uint32Array, 'entity ids');
  if (slots.uvs !== undefined) mesh.uvs = expectArray(record, slots.uvs, Float32Array, 'uvs');
  if (record.texture) {
    mesh.texture = { rgba: expectArray(record, slots.textureRgba, Uint8Array, 'texture pixels'), ...record.texture };
  }
  const appearance = record.appearance;
  if (appearance) {
    const sourceIndices = 'pooled' in appearance.source
      ? context.source(appearance.source.pooled)
      : expectArray(record, appearance.source.slot, Uint32Array, 'canonical source');
    mesh.appearanceSource = {
      kind: 'canonical-item',
      indices: expectArray(record, appearance.fence, Uint32Array, 'appearance fence'),
      sourceIndices,
      ...(appearance.corners !== undefined
        ? { cornerIndices: expectArray(record, appearance.corners, Uint32Array, 'corner mapping') } : {}),
    };
  }
  if (record.bitmapTextureId !== undefined) {
    const bitmap = context.bitmap(record.bitmapTextureId);
    if (!bitmap) throw new Error(`Texture image ${record.bitmapTextureId} is no longer available`);
    mesh.textureBitmap = bitmap;
  }
  return mesh;
}

/** Decoded bytes a record will occupy, sources excluded (they are shared). */
export function recordArrayBytes(record: MeshRecord): number {
  let bytes = 0;
  for (const array of record.arrays) bytes += array.byteLength;
  return bytes;
}
