/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createImportedGeometryKernel } from './generated/imported-geometry-static.js';

export interface ImportedOperationIdentity {
  store: number;
  revision: number;
  definition: number;
  occurrence: number;
}
export type TransformStack = readonly (readonly (readonly number[])[])[];
export interface ImportedMeshSource {
  points: readonly (readonly number[])[];
  faceVertexIndices: readonly number[];
  faceVertexCounts?: readonly number[];
  normals?: readonly (readonly number[])[];
}
interface KernelExports {
  memory: { readonly buffer: ArrayBuffer };
  imported_alloc(length: number): number;
  imported_free(pointer: number, length: number): void;
  imported_run(pointer: number, length: number): number;
}
let cachedKernel: KernelExports | undefined;
function instance(): KernelExports { return cachedKernel ??= createImportedGeometryKernel(); }
class Packet {
  private bytes = new Uint8Array(1024);
  private view = new DataView(this.bytes.buffer);
  private offset = 0;
  constructor(kind: number) { this.u32(1); this.u32(kind); }
  private reserve(length: number): void {
    const needed = this.offset + length;
    if (!Number.isSafeInteger(needed) || needed > 0xffffffff) throw new RangeError('Imported geometry packet exceeds u32 address space');
    if (needed <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < needed) capacity = Math.min(0xffffffff, capacity * 2);
    const next = new Uint8Array(capacity);
    next.set(this.bytes.subarray(0, this.offset));
    this.bytes = next; this.view = new DataView(next.buffer);
  }
  u32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Imported geometry packet u32 overflow');
    this.reserve(4); this.view.setUint32(this.offset, value, true); this.offset += 4;
  }
  identity(identity?: ImportedOperationIdentity): void {
    const values = identity ? [identity.store, identity.revision, identity.definition, identity.occurrence] : [1, 1, 1, nextOccurrence++];
    this.reserve(32);
    for (const value of values) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Imported geometry identity must be a nonnegative safe integer');
      this.view.setBigUint64(this.offset, BigInt(value), true); this.offset += 8;
    }
  }
  values(values: ArrayLike<number>): void {
    this.u32(values.length); this.reserve(values.length * 8);
    for (let i = 0; i < values.length; i++) { this.view.setFloat64(this.offset, values[i], true); this.offset += 8; }
  }
  indices(values: Uint32Array): void {
    this.u32(values.length); this.reserve(values.length * 4);
    for (const value of values) { this.view.setUint32(this.offset, value, true); this.offset += 4; }
  }
  rows(rows: readonly (readonly number[])[]): void { this.u32(rows.length); for (const row of rows) this.values(row); }
  stack(stack: TransformStack): void { this.u32(stack.length); for (const matrix of stack) this.rows(matrix); }
  run(): ResultPacket { return new ResultPacket(runImportedPacket(this.bytes.subarray(0, this.offset))); }
}
/** Execute any versioned numeric or graph-control packet. Returns the complete
 * length/status/payload packet, throwing its UTF-8 error when status is nonzero. */
export function runImportedPacket(input: Uint8Array): Uint8Array {
    if (input.length > 0xffffffff) throw new RangeError('Imported geometry packet exceeds u32 address space');
    const k = instance(); const pointer = k.imported_alloc(input.length) >>> 0;
    let output = 0; let outputLength = 0;
    try {
      new Uint8Array(k.memory.buffer, pointer, input.length).set(input);
      output = k.imported_run(pointer, input.length) >>> 0;
      outputLength = new DataView(k.memory.buffer).getUint32(output, true);
      const bytes = new Uint8Array(k.memory.buffer, output, outputLength).slice();
      const status = new DataView(bytes.buffer).getUint32(4, true);
      if (status) throw new Error(new TextDecoder().decode(bytes.subarray(8)));
      return bytes;
    } finally {
      k.imported_free(pointer, input.length);
      if (output) k.imported_free(output, outputLength);
    }
}
let nextOccurrence = 1;
class ResultPacket {
  private offset = 8;
  private view: DataView;
  constructor(bytes: Uint8Array) { this.view = new DataView(bytes.buffer); }
  floats(): Float32Array {
    const n = this.view.getUint32(this.offset, true); this.offset += 4;
    const out = new Float32Array(n);
    // Copy bits, including NaN and negative zero, without a JSON conversion.
    const bits = new Uint32Array(out.buffer);
    for (let i = 0; i < n; i++) { bits[i] = this.view.getUint32(this.offset, true); this.offset += 4; }
    return out;
  }
  indices(): Uint32Array {
    const n = this.view.getUint32(this.offset, true); this.offset += 4;
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) { out[i] = this.view.getUint32(this.offset, true); this.offset += 4; }
    return out;
  }
  triple(): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) { out[i] = this.view.getFloat64(this.offset, true); this.offset += 8; }
    return out;
  }
}
export function stageTransform(stack: TransformStack): Float32Array | null {
  const p = new Packet(1); p.stack(stack); const values = p.run().floats(); return values.length ? values : null;
}
export function executeMesh(source: ImportedMeshSource, stack: TransformStack, identity?: ImportedOperationIdentity): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const p = new Packet(2); p.identity(identity); p.stack(stack); p.rows(source.points); p.values(source.faceVertexIndices ?? []);
  p.u32(source.faceVertexCounts ? 1 : 0); if (source.faceVertexCounts) p.values(source.faceVertexCounts);
  p.u32(source.normals ? 1 : 0); if (source.normals) p.rows(source.normals);
  const result = p.run(); return { positions: result.floats(), normals: result.floats(), indices: result.indices() };
}
export function executePoints(source: Float32Array | Float64Array | readonly (readonly number[])[], stack: TransformStack, identity?: ImportedOperationIdentity): { positions: Float32Array; bbox: { min: [number, number, number]; max: [number, number, number] } } {
  const p = new Packet(3); p.identity(identity); p.stack(stack);
  p.values(source instanceof Float32Array || source instanceof Float64Array ? source : source.flatMap(row => [...row]));
  const result = p.run(); return { positions: result.floats(), bbox: { min: result.triple(), max: result.triple() } };
}
export function stageUvs(values: ArrayLike<number>): Float32Array {
  const p = new Packet(4); p.values(values); return p.run().floats();
}
export function computeNormalMatrix(matrix: Float32Array): Float32Array | null {
  const p = new Packet(5); p.values(matrix); const out = p.run().floats(); return out.length ? out : null;
}
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const p = new Packet(6); p.values(positions); p.indices(indices);
  return p.run().floats();
}
