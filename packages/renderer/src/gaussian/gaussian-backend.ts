/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single packed upstream source holding every asset (#8564): one upstream
 * global sort and one draw, no 64-run limit, no slab fallback. Positions are
 * world coordinates relative to the layer's RTE anchor.
 *
 * #9018: the heavy columns live only on the GPU. The CPU keeps just what the
 * upstream depth sort and the centre clip read (`GaussianSortColumns`).
 */
export interface GaussianPackedLayout {
  readonly rows: number;
  readonly shDegree: 0 | 1 | 2 | 3;
  /** `float16x2`: two half coefficients per 32-bit word, row-major, no per-row padding. */
  readonly shEncoding: 'float32' | 'float16x2';
}

/** CPU columns retained with the drawn data: anchor-local centres, opacities and asset slots. */
export interface GaussianSortColumns {
  readonly positions: Float32Array;
  readonly opacities: Float32Array;
  /** Asset slot per row; 0 marks padding. Slots are never reused, so stale rows can always be excluded. */
  readonly semanticIds: Uint32Array;
}

/** Placed rows ready for the GPU. `sphericalHarmonics` holds coefficient words in the layout's encoding. */
export interface GaussianGpuRows {
  readonly positions: Float32Array;
  readonly scales: Float32Array;
  readonly rotations: Float32Array;
  readonly colors: Float32Array;
  readonly opacities: Float32Array;
  readonly semanticIds: Uint32Array;
  readonly sphericalHarmonics?: Float32Array | Uint32Array;
}

/** Fills a new GPU allocation. Rows starting a write or copy are even, so float16x2 words never straddle. */
export interface GaussianRowWriter {
  write(row: number, rows: GaussianGpuRows): void;
  /** GPU-side copy of rows from the currently drawn data, which has the same layout. */
  copy(fromRow: number, toRow: number, rows: number): void;
}

export type GaussianRowFilter = (semanticId: number | undefined, rowIndex: number) => boolean;

/** Viewer-owned frame resources. A backend borrows them for one pass and never destroys them. */
export interface GaussianEncodeTarget {
  readonly encoder: GPUCommandEncoder;
  readonly colorView: GPUTextureView;
  readonly resolveTarget?: GPUTextureView;
  readonly depthView: GPUTextureView;
  readonly colorFormat: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  readonly sampleCount: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Per-sample split of one splat draw (#8564): keep samples whose depth is `greater`
 * than `bound` (in front, reverse-Z) or its exact complement `less-equal`.
 */
export interface GaussianDepthInterval {
  readonly bound: GPUTexture;
  readonly compare: 'greater' | 'less-equal';
}

/** Camera expressed in the packed source's anchor-relative space. */
export interface GaussianEncodeCamera {
  readonly modelViewProjection: Float64Array;
  readonly cameraPosition: readonly [number, number, number];
}

/** Per-device upstream renderer state. Owns only allocations it made itself. */
export interface GaussianBackendScene {
  readonly gpuBytes: number;
  /**
   * Allocate `layout`, let `fill` write it, verify the allocation, then draw it.
   * On any failure (including `fill` throwing) the new allocation is released and
   * the previous data stays drawable. `fill` returns the CPU columns to retain.
   */
  replaceRows(layout: GaussianPackedLayout, fill: (writer: GaussianRowWriter) => Promise<GaussianSortColumns>): Promise<void>;
  /** Draw only rows whose asset slot is in `include` and that pass `predicate`. */
  setFilter(include: ReadonlySet<number>, predicate: GaussianRowFilter | null): void;
  /**
   * Record one pass that loads the viewer colour, tests read-only depth and resolves if requested.
   * With `interval`, only the samples on its side of the bound are written (same sort, same colour).
   */
  encode(target: GaussianEncodeTarget, camera: GaussianEncodeCamera, interval?: GaussianDepthInterval): void;
  /** Internal opt-in evidence, called only after encoding a diagnostic frame. */
  captureDiagnostics?(): Record<string, unknown>;
  destroy(): void;
}

export interface GaussianBackend {
  /** True only when upstream sorts reverse-Z depth back to front (luma.gl #3619). */
  readonly upstreamReverseZ: boolean;
  /** True when upstream has the per-sample depth-interval hook the nearest-glass split needs (#8564). */
  readonly upstreamDepthInterval?: boolean;
  createScene(): GaussianBackendScene;
}

export type GaussianBackendFactory = (
  device: GPUDevice,
  adapter: GPUAdapter | null,
  onError: (error: Error) => void,
) => Promise<GaussianBackend>;
