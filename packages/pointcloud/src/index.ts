/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/pointcloud — point cloud decoders, streaming sources, and
 * a worker-backed host for off-main-thread decoding.
 *
 * Phase 0: IFCx schemas (`pcd::base64`, `points::array`, `points::base64`).
 * Phase 1: streaming `.las` from local Files / fetched Blobs.
 * Phase 2: streaming `.laz` (laz-perf in the worker).
 */

export type { DecodedPointChunk, PointCloudBBox } from './types.js';

// Inline / IFCx decoders (Phase 0)
export { decodePcd } from './formats/pcd.js';
export {
  decodePointsArray,
  decodePointsBase64,
  type PointsArrayAttribute,
  type PointsBase64Attribute,
} from './formats/ifcx-points.js';
export { decompressLZF } from './lzf.js';
export {
  POINTCLOUD_ATTR,
  POINTCLOUD_ATTR_KEYS,
  decodeIfcxPointAttribute,
} from './from-ifcx-attributes.js';

// LAS reader primitives
export {
  parseLasHeader,
  decodeLasPoints,
  sampleMaxRgbChannel,
  type LasHeader,
} from './formats/las.js';

// Streaming sources & worker host (Phase 1+)
export type {
  StreamingPointSource,
  PointSourceInfo,
  DownsampleHint,
} from './streaming/types.js';
export { LasStreamingSource } from './streaming/las-source.js';
export { LazStreamingSource } from './streaming/laz-source.js';
export { PlyStreamingSource } from './streaming/ply-source.js';
export { PcdStreamingSource } from './streaming/pcd-source.js';
export { parsePlyHeader } from './formats/ply.js';
export { BlobByteSource } from './streaming/blob-source.js';
export {
  createDecodeWorkerSource,
  type CreateDecodeWorkerSourceOptions,
  type DecodeWorkerOptions,
  type DecodeWorkerFormat,
} from './streaming/worker-client.js';
export {
  streamPointCloud,
  type StreamPointCloudOptions,
  type StreamHandle,
} from './streaming/host.js';
