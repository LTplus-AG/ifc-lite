/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';

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
