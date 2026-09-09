/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';

const MAX_INDICES = 300_000_000;
const invalid = () => new Error('Invalid cache: malformed canonical appearance provenance; rebuild this cache.');
export type AppearanceSourcePool = ReadonlyMap<Uint32Array, number>;
function equal(a: Uint32Array, b: Uint32Array): boolean {
  return a === b || (a.length === b.length && a.every((value, index) => value === b[index]));
}
function validate(mesh: MeshData): NonNullable<MeshData['appearanceSource']> | undefined {
  const source = mesh.appearanceSource;
  if (!source) return undefined;
  if (source.kind !== 'canonical-item' || source.indices !== mesh.indices || mesh.entityIds ||
      !Number.isSafeInteger(mesh.geometryItemId) || mesh.geometryItemId! <= 0 || mesh.geometryItemId! >= 0xffffffff ||
      mesh.indices.length === 0 || mesh.indices.length % 3 !== 0 ||
      !(source.sourceIndices instanceof Uint32Array) || source.sourceIndices.length === 0 ||
      source.sourceIndices.length > MAX_INDICES || source.sourceIndices.length % 3 !== 0) throw invalid();
  for (const vertex of mesh.indices) if (vertex >= mesh.positions.length / 3) throw invalid();
  if (source.cornerIndices) {
    if (!(source.cornerIndices instanceof Uint32Array) || source.cornerIndices.length !== mesh.indices.length) throw invalid();
    for (const corner of source.cornerIndices) if (corner >= source.sourceIndices.length) throw invalid();
  } else if (source.sourceIndices.length !== mesh.indices.length) throw invalid();
  return source;
}
function tag(mesh: MeshData, pool?: AppearanceSourcePool): number {
  const source = validate(mesh);
  if (!source) return 0;
  if (!source.cornerIndices && equal(source.sourceIndices, mesh.indices)) return 1;
  if (pool?.has(source.sourceIndices)) return source.cornerIndices ? 5 : 4;
  return source.cornerIndices ? 3 : 2;
}
export function provenanceByteLength(mesh: MeshData, pool?: AppearanceSourcePool): number {
  const mode = tag(mesh, pool), source = mesh.appearanceSource;
  return mode < 2 ? 1 : 5 + (mode < 4 ? source!.sourceIndices.byteLength : 0) +
    (source!.cornerIndices ? source!.cornerIndices.byteLength : 0);
}
export function writeProvenance(writer: BufferWriter, mesh: MeshData, pool?: AppearanceSourcePool): void {
  const mode = tag(mesh, pool), source = mesh.appearanceSource;
  writer.writeUint8(mode);
  if (mode < 2) return;
  writer.writeUint32(mode >= 4 ? pool!.get(source!.sourceIndices)! : source!.sourceIndices.length);
  if (mode < 4) writer.writeTypedArray(source!.sourceIndices);
  if (source!.cornerIndices) writer.writeTypedArray(source!.cornerIndices);
}
export function readProvenance(reader: BufferReader, mesh: MeshData, pool: readonly Uint32Array[] = []): void {
  const mode = reader.readUint8();
  if (mode === 0) return; // Never infer canonical identity from geometryItemId alone.
  if (mode > 5) throw invalid();
  let sourceIndices = mesh.indices;
  if (mode >= 2) {
    const value = reader.readUint32();
    if (mode >= 4) {
      if (!pool[value]) throw invalid();
      sourceIndices = pool[value];
    } else {
      if (value > MAX_INDICES || value === 0 || value % 3 !== 0) throw invalid();
      sourceIndices = reader.readUint32Array(value);
    }
  }
  const cornerIndices = mode === 3 || mode === 5 ? reader.readUint32Array(mesh.indices.length) : undefined;
  mesh.appearanceSource = { kind: 'canonical-item', indices: mesh.indices, sourceIndices,
    ...(cornerIndices ? { cornerIndices } : {}) };
  validate(mesh);
}
/** Deduplicate by existing source-array identity across every spatial chunk. */
export function collectSourcePool(meshes: readonly MeshData[]): Map<Uint32Array, number> {
  const pool = new Map<Uint32Array, number>();
  for (const mesh of meshes) {
    if (tag(mesh) < 2) continue;
    const source = mesh.appearanceSource!.sourceIndices;
    if (!pool.has(source)) pool.set(source, pool.size);
  }
  return pool;
}
export function writeSourcePool(writer: BufferWriter, pool: AppearanceSourcePool): void {
  writer.writeUint32(pool.size);
  for (const source of pool.keys()) { writer.writeUint32(source.length); writer.writeTypedArray(source); }
}
export function readSourcePool(reader: BufferReader, meshCount: number, end: number): Uint32Array[] {
  const count = reader.readUint32();
  if (count > meshCount || count > Math.floor((end - reader.position) / 4)) throw invalid();
  const pool: Uint32Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = reader.readUint32();
    if (!length || length > MAX_INDICES || length % 3 !== 0 || length > Math.floor((end - reader.position) / 4)) throw invalid();
    pool.push(reader.readUint32Array(length));
  }
  return pool;
}
