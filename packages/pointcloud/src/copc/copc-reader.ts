/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COPC reader (#6869): header + info VLR, hierarchy pages, and per-node
 * decode over any `RangeByteSource` (a local File, or HTTP Range).
 *
 * Node data is one LAZ chunk per node, decompressed with laz-perf's
 * `ChunkDecoder` and then decoded by the SAME `decodeLasPoints` the LAS and
 * LAZ sources use, so PDRF 6/7/8 field layout, 8-bit RGB detection and the
 * f64 `originOffset` subtraction (#1804) have exactly one implementation.
 *
 * The reader holds no hierarchy state: it reads and parses pages, and the
 * owner (worker client, LOD driver, test) keeps the `CopcHierarchy`. That
 * lets the reader live in the decode worker while the hierarchy lives with
 * the LOD selection on the main thread.
 */

import { bboxInDecodedFrame, decodeLasPoints, sampleMaxRgbChannel, type LasHeader } from '../formats/las.js';
import { loadLazPerf, type LazPerfModule } from '../streaming/laz-perf-loader.js';
import type { RangeByteSource } from '../streaming/types.js';
import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import { readCopcFileInfo, voxelKeyId, type CopcFileInfo } from './copc-info.js';
import {
  MAX_COPC_NODE_POINTS,
  parseCopcHierarchyPage,
  type CopcHierarchyPage,
  type CopcNodeEntry,
  type CopcPageRef,
} from './copc-hierarchy.js';

export interface CopcReadNodeOptions {
  /** Keep every `stride`-th point of the node (>= 1). The whole chunk is still decompressed. */
  stride?: number;
  signal?: AbortSignal;
}

export class CopcReader {
  /** Locked by the first decoded node so every node shares one colour scale. */
  private rgbScale: number | undefined;

  private constructor(
    private readonly source: RangeByteSource,
    readonly file: CopcFileInfo,
    readonly originOffset: readonly [number, number, number] | undefined,
  ) {}

  /** Read and validate the header and info VLR. No point data is read. */
  static async open(
    source: RangeByteSource,
    options: { originOffset?: readonly [number, number, number]; signal?: AbortSignal } = {},
  ): Promise<CopcReader> {
    const file = await readCopcFileInfo(source, options.signal);
    return new CopcReader(source, file, options.originOffset);
  }

  get header(): LasHeader {
    return this.file.header;
  }

  /** The root hierarchy page's location. */
  get rootPageRef(): CopcPageRef {
    return {
      key: { d: 0, x: 0, y: 0, z: 0 },
      offset: this.file.info.rootHierOffset,
      byteSize: this.file.info.rootHierSize,
    };
  }

  /** Header bounds in the decoded frame (with `originOffset` subtracted). */
  get bbox(): PointCloudBBox {
    return bboxInDecodedFrame(this.file.header.bbox, this.originOffset);
  }

  async readPage(ref: CopcPageRef, signal?: AbortSignal): Promise<CopcHierarchyPage> {
    if (ref.offset + ref.byteSize > this.file.fileSize || ref.byteSize <= 0) {
      throw new Error(`COPC: page ${voxelKeyId(ref.key)} lies outside the file`);
    }
    const bytes = await this.source.read(ref.offset, ref.offset + ref.byteSize, signal);
    if (bytes.length !== ref.byteSize) throw new Error(`COPC: page ${voxelKeyId(ref.key)} truncated`);
    return parseCopcHierarchyPage(bytes, this.file.fileSize);
  }

  /** Fetch and decode one node. */
  async readNode(entry: CopcNodeEntry, options: CopcReadNodeOptions = {}): Promise<DecodedPointChunk> {
    const { header, fileSize } = this.file;
    const id = voxelKeyId(entry.key);
    if (!Number.isSafeInteger(entry.pointCount) || entry.pointCount < 0 || entry.pointCount > MAX_COPC_NODE_POINTS) {
      throw new Error(`COPC: node ${id} has invalid point count ${entry.pointCount}`);
    }
    if (entry.pointCount === 0) return emptyChunk(header);
    if (entry.byteSize <= 0 || entry.offset < header.pointDataOffset || entry.offset + entry.byteSize > fileSize) {
      throw new Error(`COPC: node ${id} data lies outside the point block`);
    }
    const compressed = await this.source.read(entry.offset, entry.offset + entry.byteSize, options.signal);
    if (compressed.length !== entry.byteSize) throw new Error(`COPC: node ${id} truncated`);
    const mod = await loadLazPerf();
    options.signal?.throwIfAborted();
    const stride = Math.max(1, Math.floor(options.stride ?? 1));
    const { slab, count } = decompressCopcChunk(mod, compressed, header, entry.pointCount, stride);
    if (this.rgbScale === undefined) {
      const max = sampleMaxRgbChannel(slab, { ...header, pointCount: count });
      this.rgbScale = header.hasRgb && max > 0 && max <= 255 ? 65535 / 255 : 1;
    }
    return decodeLasPoints(slab, header, count, header.pointRecordLength, this.rgbScale, this.originOffset);
  }
}

/**
 * Decompress a node's chunk (`pointCount` records), keeping every
 * `stride`-th record. Wasm allocations are freed on every path.
 */
export function decompressCopcChunk(
  mod: LazPerfModule,
  compressed: Uint8Array,
  header: LasHeader,
  pointCount: number,
  stride: number,
): { slab: Uint8Array; count: number } {
  const recordLength = header.pointRecordLength;
  const count = Math.ceil(pointCount / stride);
  const slab = new Uint8Array(count * recordLength);
  const dataPtr = mod._malloc(compressed.byteLength);
  const pointPtr = mod._malloc(recordLength);
  const decoder = new mod.ChunkDecoder();
  try {
    mod.HEAPU8.set(compressed, dataPtr);
    decoder.open(header.pointDataFormatId, recordLength, dataPtr);
    let write = 0;
    for (let i = 0; i < pointCount; i++) {
      decoder.getPoint(pointPtr);
      if (i % stride === 0) {
        // Re-read HEAPU8 each time: a wasm memory growth detaches the old view.
        slab.set(mod.HEAPU8.subarray(pointPtr, pointPtr + recordLength), write * recordLength);
        write++;
      }
    }
    return { slab, count };
  } finally {
    decoder.delete();
    mod._free(pointPtr);
    mod._free(dataPtr);
  }
}

function emptyChunk(header: LasHeader): DecodedPointChunk {
  return {
    positions: new Float32Array(0),
    colors: header.hasRgb ? new Float32Array(0) : undefined,
    normalState: 'absent',
    classifications: new Uint8Array(0),
    intensities: new Uint16Array(0),
    pointCount: 0,
    bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  };
}
