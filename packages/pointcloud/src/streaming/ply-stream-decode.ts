/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { normalizePlyColors } from '../formats/ply-color.js';
import { readPlyScalar } from '../formats/ply-scalar.js';
import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import type { PlyHeader, PlyPropertyDecl, PlyVertexLayout } from '../formats/ply.js';

export const PLY_STREAM_READ_BYTES = 4 * 1024 * 1024;
const TEXT_DECODER = new TextDecoder();

interface Channels {
  r?: PlyPropertyDecl; g?: PlyPropertyDecl; b?: PlyPropertyDecl;
  intensity?: PlyPropertyDecl;
}

export interface PlyStreamInstrumentation {
  /** Test-only observation of output channel capacity; no source-count buffer is allocated. */
  onOutputAllocation?: (pointCapacity: number) => void;
}

export async function scanPlyBounds(
  blob: Blob,
  header: PlyHeader,
  layout: PlyVertexLayout,
  origin: readonly [number, number, number] | undefined,
  signal?: AbortSignal,
): Promise<PointCloudBBox> {
  if (!Number.isSafeInteger(layout.vertex.count) || layout.vertex.count < 0) {
    throw new Error(`PLY: invalid vertex count ${layout.vertex.count}`);
  }
  const bounds = emptyBounds();
  if (header.format === 'ascii') {
    const cursor = new AsciiLineCursor(blob, header.bodyOffset);
    const indices = positionColumns(layout);
    for (let row = 0; row < layout.vertex.count; row++) {
      abortIfAborted(signal);
      const line = await cursor.next(signal);
      if (line === null) throw new Error(`PLY ascii: expected ${layout.vertex.count} vertex lines, got ${row}`);
      const parts = line.split(/\s+/);
      requireColumns(parts, layout.vertex.properties.length, row);
      extendBounds(bounds, Number(parts[indices[0]]) - (origin?.[0] ?? 0), Number(parts[indices[1]]) - (origin?.[1] ?? 0), Number(parts[indices[2]]) - (origin?.[2] ?? 0));
    }
  } else {
    const recordSize = layout.vertex.recordSize;
    const bodyBytes = layout.vertex.count * recordSize;
    const requiredEnd = header.bodyOffset + bodyBytes;
    if (!Number.isSafeInteger(bodyBytes) || !Number.isSafeInteger(requiredEnd)) throw new Error('PLY: binary vertex byte span exceeds the safe integer range');
    if (blob.size < requiredEnd) throw new Error(`PLY binary: expected ${layout.vertex.count * recordSize} body bytes, got ${blob.size - header.bodyOffset}`);
    const recordsPerRead = Math.max(1, Math.floor(PLY_STREAM_READ_BYTES / recordSize));
    for (let first = 0; first < layout.vertex.count; first += recordsPerRead) {
      abortIfAborted(signal);
      const count = Math.min(recordsPerRead, layout.vertex.count - first);
      const bytes = await readSlice(blob, header.bodyOffset + first * recordSize, count * recordSize, signal);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let row = 0; row < count; row++) extendBinaryBounds(bounds, view, row * recordSize, layout, header, origin);
    }
  }
  return bounds;
}

export class PlyChunkReader {
  private sourceRow = 0;
  private readonly ascii: AsciiLineCursor | null;
  private readonly channels: Channels;

  constructor(
    private readonly blob: Blob,
    private readonly header: PlyHeader,
    private readonly layout: PlyVertexLayout,
    private readonly stride: number,
    private readonly origin: readonly [number, number, number] | undefined,
    private readonly instrumentation?: PlyStreamInstrumentation,
  ) {
    this.ascii = header.format === 'ascii' ? new AsciiLineCursor(blob, header.bodyOffset) : null;
    this.channels = findChannels(layout);
  }

  async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
    abortIfAborted(signal);
    if (this.sourceRow >= this.layout.vertex.count) return null;
    const limit = Math.max(1, Math.floor(maxPoints));
    const remainingOutput = countRetainedRows(this.sourceRow, this.layout.vertex.count, this.stride);
    if (remainingOutput === 0) return null;
    const capacity = Math.min(limit, remainingOutput);
    this.instrumentation?.onOutputAllocation?.(capacity);
    const output = allocateChunk(capacity, this.layout, this.channels);
    const written = this.ascii
      ? await this.readAscii(output, capacity, signal)
      : await this.readBinary(output, capacity, signal);
    return finishChunk(output, written, this.channels);
  }

  private async readBinary(output: DecodedPointChunk, capacity: number, signal?: AbortSignal): Promise<number> {
    const recordSize = this.layout.vertex.recordSize;
    const recordsPerRead = Math.max(1, Math.floor(PLY_STREAM_READ_BYTES / recordSize));
    let written = 0;
    while (written < capacity && this.sourceRow < this.layout.vertex.count) {
      this.sourceRow += (this.stride - (this.sourceRow % this.stride)) % this.stride;
      if (this.sourceRow >= this.layout.vertex.count) break;
      const sourceTake = Math.min(recordsPerRead, this.layout.vertex.count - this.sourceRow);
      const bytes = await readSlice(this.blob, this.header.bodyOffset + this.sourceRow * recordSize, sourceTake * recordSize, signal);
      if (bytes.byteLength !== sourceTake * recordSize) {
        throw new Error(`PLY binary: expected ${sourceTake * recordSize} body bytes, got ${bytes.byteLength}`);
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let processed = 0;
      while (processed < sourceTake && written < capacity) {
        const globalRow = this.sourceRow + processed;
        if (globalRow % this.stride === 0) {
          writeBinaryRow(output, written++, view, processed * recordSize, this.layout, this.channels, this.header, this.origin);
        }
        processed++;
      }
      this.sourceRow += processed;
    }
    return written;
  }

  private async readAscii(output: DecodedPointChunk, capacity: number, signal?: AbortSignal): Promise<number> {
    const columns = asciiColumns(this.layout, this.channels);
    let written = 0;
    while (written < capacity && this.sourceRow < this.layout.vertex.count) {
      const line = await this.ascii!.next(signal);
      if (line === null) throw new Error(`PLY ascii: expected ${this.layout.vertex.count} vertex lines, got ${this.sourceRow}`);
      const parts = line.split(/\s+/);
      requireColumns(parts, this.layout.vertex.properties.length, this.sourceRow);
      if (this.sourceRow % this.stride === 0) writeAsciiRow(output, written++, parts, columns, this.origin);
      this.sourceRow++;
    }
    return written;
  }
}

class AsciiLineCursor {
  private byteOffset: number;
  private pending = '';
  private pendingOffset = 0;
  private eof = false;

  constructor(private readonly blob: Blob, bodyOffset: number) { this.byteOffset = bodyOffset; }

  async next(signal?: AbortSignal): Promise<string | null> {
    while (true) {
      const newline = this.pending.indexOf('\n', this.pendingOffset);
      if (newline >= 0) {
        const line = this.pending.slice(this.pendingOffset, newline).trim();
        this.pendingOffset = newline + 1;
        this.compact();
        if (line) return line;
        continue;
      }
      if (this.eof) {
        const line = this.pending.slice(this.pendingOffset).trim();
        this.pendingOffset = this.pending.length;
        return line || null;
      }
      if (this.pending.length - this.pendingOffset >= PLY_STREAM_READ_BYTES * 2) {
        throw new Error('PLY ascii: vertex row exceeds the bounded 8 MiB line limit');
      }
      abortIfAborted(signal);
      const end = Math.min(this.blob.size, this.byteOffset + PLY_STREAM_READ_BYTES);
      const bytes = await readSlice(this.blob, this.byteOffset, end - this.byteOffset, signal);
      this.byteOffset = end;
      this.pending += TEXT_DECODER.decode(bytes);
      this.eof = end >= this.blob.size;
    }
  }

  private compact(): void {
    if (this.pendingOffset < PLY_STREAM_READ_BYTES) return;
    this.pending = this.pending.slice(this.pendingOffset);
    this.pendingOffset = 0;
  }
}

function allocateChunk(capacity: number, layout: PlyVertexLayout, channels: Channels): DecodedPointChunk {
  return {
    positions: new Float32Array(capacity * 3),
    colors: channels.r && channels.g && channels.b ? new Float32Array(capacity * 3) : undefined,
    normals: layout.nxProp && layout.nyProp && layout.nzProp ? new Float32Array(capacity * 3) : undefined,
    intensities: channels.intensity ? new Uint16Array(capacity) : undefined,
    pointCount: capacity,
    bbox: emptyBounds(),
  };
}

function finishChunk(output: DecodedPointChunk, written: number, channels: Channels): DecodedPointChunk {
  if (output.colors && channels.r && channels.g && channels.b) normalizePlyColors(output.colors, [channels.r.type, channels.g.type, channels.b.type]);
  output.pointCount = written;
  output.bbox = computeBounds(output.positions, written);
  if (written === output.positions.length / 3) return output;
  output.positions = output.positions.slice(0, written * 3);
  if (output.colors) output.colors = output.colors.slice(0, written * 3);
  if (output.normals) output.normals = output.normals.slice(0, written * 3);
  if (output.intensities) output.intensities = output.intensities.slice(0, written);
  return output;
}

function writeBinaryRow(output: DecodedPointChunk, dst: number, view: DataView, base: number, layout: PlyVertexLayout, channels: Channels, header: PlyHeader, origin?: readonly [number, number, number]): void {
  const le = header.format === 'binary_little_endian';
  output.positions[dst * 3] = scalar(view, base, layout.xProp, le) - (origin?.[0] ?? 0);
  output.positions[dst * 3 + 1] = scalar(view, base, layout.yProp, le) - (origin?.[1] ?? 0);
  output.positions[dst * 3 + 2] = scalar(view, base, layout.zProp, le) - (origin?.[2] ?? 0);
  if (output.colors && channels.r && channels.g && channels.b) {
    output.colors[dst * 3] = scalar(view, base, channels.r, le); output.colors[dst * 3 + 1] = scalar(view, base, channels.g, le); output.colors[dst * 3 + 2] = scalar(view, base, channels.b, le);
  }
  if (output.normals && layout.nxProp && layout.nyProp && layout.nzProp) {
    output.normals[dst * 3] = scalar(view, base, layout.nxProp, le); output.normals[dst * 3 + 1] = scalar(view, base, layout.nyProp, le); output.normals[dst * 3 + 2] = scalar(view, base, layout.nzProp, le);
  }
  if (output.intensities && channels.intensity) output.intensities[dst] = clampIntensity(scalar(view, base, channels.intensity, le));
}

interface AsciiColumns { x: number; y: number; z: number; r: number; g: number; b: number; nx: number; ny: number; nz: number; intensity: number }
function writeAsciiRow(output: DecodedPointChunk, dst: number, parts: string[], columns: AsciiColumns, origin?: readonly [number, number, number]): void {
  output.positions[dst * 3] = Number(parts[columns.x]) - (origin?.[0] ?? 0);
  output.positions[dst * 3 + 1] = Number(parts[columns.y]) - (origin?.[1] ?? 0);
  output.positions[dst * 3 + 2] = Number(parts[columns.z]) - (origin?.[2] ?? 0);
  if (output.colors) {
    output.colors[dst * 3] = Number(parts[columns.r]); output.colors[dst * 3 + 1] = Number(parts[columns.g]); output.colors[dst * 3 + 2] = Number(parts[columns.b]);
  }
  if (output.normals) {
    output.normals[dst * 3] = Number(parts[columns.nx]); output.normals[dst * 3 + 1] = Number(parts[columns.ny]); output.normals[dst * 3 + 2] = Number(parts[columns.nz]);
  }
  if (output.intensities) output.intensities[dst] = clampIntensity(Number(parts[columns.intensity]));
}

function extendBinaryBounds(bounds: PointCloudBBox, view: DataView, base: number, layout: PlyVertexLayout, header: PlyHeader, origin?: readonly [number, number, number]): void {
  const le = header.format === 'binary_little_endian';
  extendBounds(bounds, readPlyScalar(view, base + layout.xProp.offset, layout.xProp, le) - (origin?.[0] ?? 0), readPlyScalar(view, base + layout.yProp.offset, layout.yProp, le) - (origin?.[1] ?? 0), readPlyScalar(view, base + layout.zProp.offset, layout.zProp, le) - (origin?.[2] ?? 0));
}

function findChannels(layout: PlyVertexLayout): Channels {
  const find = (...names: string[]) => layout.vertex.properties.find((property) => names.includes(property.name));
  return { r: find('red', 'r'), g: find('green', 'g'), b: find('blue', 'b'), intensity: find('intensity', 'scalar_Intensity') };
}
function positionColumns(layout: PlyVertexLayout): [number, number, number] { return [layout.vertex.properties.indexOf(layout.xProp), layout.vertex.properties.indexOf(layout.yProp), layout.vertex.properties.indexOf(layout.zProp)]; }
function asciiColumns(layout: PlyVertexLayout, channels: Channels): AsciiColumns {
  const index = (property?: PlyPropertyDecl) => property ? layout.vertex.properties.indexOf(property) : -1;
  return { x: index(layout.xProp), y: index(layout.yProp), z: index(layout.zProp), r: index(channels.r), g: index(channels.g), b: index(channels.b), nx: index(layout.nxProp), ny: index(layout.nyProp), nz: index(layout.nzProp), intensity: index(channels.intensity) };
}
function requireColumns(parts: string[], count: number, row: number): void { if (parts.length < count) throw new Error(`PLY ascii: vertex row ${row + 1} has ${parts.length} values; expected ${count}`); }
function clampIntensity(value: number): number { return Math.min(65535, Math.max(0, value | 0)); }
function scalar(view: DataView, base: number, property: PlyPropertyDecl, le: boolean): number { return readPlyScalar(view, base + property.offset, property, le); }
function countRetainedRows(first: number, count: number, stride: number): number {
  const aligned = first + ((stride - (first % stride)) % stride);
  return aligned >= count ? 0 : Math.floor((count - 1 - aligned) / stride) + 1;
}
function emptyBounds(): PointCloudBBox { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; }
function extendBounds(bounds: PointCloudBBox, x: number, y: number, z: number): void {
  if (x < bounds.min[0]) bounds.min[0] = x; if (x > bounds.max[0]) bounds.max[0] = x;
  if (y < bounds.min[1]) bounds.min[1] = y; if (y > bounds.max[1]) bounds.max[1] = y;
  if (z < bounds.min[2]) bounds.min[2] = z; if (z > bounds.max[2]) bounds.max[2] = z;
}
function computeBounds(positions: Float32Array, count: number): PointCloudBBox { const bounds = emptyBounds(); for (let i = 0; i < count; i++) extendBounds(bounds, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); return bounds; }
async function readSlice(blob: Blob, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> { abortIfAborted(signal); const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()); abortIfAborted(signal); return bytes; }
function abortIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
