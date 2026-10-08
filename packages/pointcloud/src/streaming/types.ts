/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

/** Explicit CRS metadata read from the source, never inferred from coordinates. */
export interface PointSourceSpatialMetadata {
  horizontalId?: string;
  verticalId?: string;
  /** Source WKT retained verbatim even when it declares only one CRS component. */
  wkt?: string;
  provenance: string;
}

/** Aggregate metadata returned from `StreamingPointSource.open()`. */
export interface PointSourceInfo {
  /** Total points the source will emit if it streams to completion. */
  totalPointCount: number;
  /** Source-wide bbox in source-native coordinates. */
  bbox: PointCloudBBox;
  /** True if the source carries per-point RGB. */
  hasColor: boolean;
  /** True if the source carries per-point classification. */
  hasClassification: boolean;
  /** True if the source carries per-point intensity. */
  hasIntensity: boolean;
  /** Free-form display label (filename, URL, etc.). */
  label?: string;
  /** Source-declared CRS metadata, available before the first decoded chunk. */
  spatialMetadata?: PointSourceSpatialMetadata;
}

/**
 * Renderer-agnostic streaming source.
 *
 * `open()` reads only enough bytes to discover header metadata.
 * Callers then drive `next()` repeatedly until it returns null.
 * Implementations should respect `signal` to abort cleanly between chunks.
 */
export interface StreamingPointSource {
  open(signal?: AbortSignal): Promise<PointSourceInfo>;
  next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null>;
  close(): void;
}

/**
 * Stride-based downsampling control.
 *
 * When the host applies a memory cap, it can request the source to skip
 * every `stride` points (always > 0) so a large file produces a coarser,
 * but still-valid, chunk stream. Sources that don't support this can
 * decode normally and ignore the hint — the host will downsample on the
 * receiving end.
 */
export interface DownsampleHint {
  stride: number;
}

/**
 * Random-access byte source: the seam that lets one reader work over a local
 * `File`/`Blob` (`BlobByteSource`) or a remote file through HTTP Range
 * requests (`HttpRangeSource`) without ever holding the whole file (#6869).
 */
export interface RangeByteSource {
  /** Total size in bytes. */
  readonly size: number;
  /**
   * Bytes `[start, end)`, clamped to the source size. A caller that needs
   * every byte it asked for must check the returned length.
   */
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}
