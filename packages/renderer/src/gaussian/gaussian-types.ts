/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NormalizedGaussianAttributes } from './gaussian-attributes.js';

/**
 * Column-major 4x4 mapping source-local Gaussian coordinates into renderer world
 * space (Y-up metres) before the model translation. Identity means "no transform":
 * no axis flip, unit or metric scale is ever inferred. Similarity transforms only.
 */
export interface GaussianSplatPlacement {
  readonly matrix: Float64Array | readonly number[];
}

/** One normalized capture. Ownership of `attributes` transfers to the renderer on a successful add. */
export interface GaussianSplatAssetInput {
  readonly attributes: NormalizedGaussianAttributes;
  readonly placement: GaussianSplatPlacement;
  /** The caller's reserved federation slot; used only for the scene model translation and ownership. */
  readonly modelIndex: number;
  readonly visible?: boolean;
}

export interface GaussianSplatAddOptions {
  /** Explicit acknowledgement that this path is unqualified; it never changes readiness. */
  readonly qualification: 'internal-unqualified';
  readonly signal?: AbortSignal;
}

/** Opaque, frozen and renderer-issued. Validated by identity; ids are never reused. */
export interface GaussianSplatHandle {
  readonly id: number;
  readonly modelIndex: number;
}

export type GaussianSplatState =
  /** Not uploaded on the current device generation (including during loss and recovery). */
  | { readonly state: 'pending' }
  | { readonly state: 'resident' }
  | { readonly state: 'failed'; readonly reason: string }
  /** Removed, cleared, disposed, or not issued by this renderer. */
  | { readonly state: 'invalid' };

/** World-space AABB of Gaussian centres. Framing only: it ignores Gaussian extent. */
export interface GaussianSplatBounds {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

export interface GaussianSplatStats {
  readonly assets: number;
  readonly splats: number;
  /** Rows of visible assets; clipping and opacity culling happen later, during sorting. */
  readonly visibleAssetSplats: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly drawnFrames: number;
  /** Wall time of the last upstream sort + draw recording, in milliseconds. */
  readonly lastEncodeMs: number;
  /** Splats are composited after the main pass, over IFC glass and X-ray (approximate). */
  readonly composition: 'over-transparent-approximate';
  readonly clipping: 'centre';
}

/** The internal adapter surface reachable through `Renderer.gaussianSplats`. */
export interface GaussianSplatApi {
  add(input: GaussianSplatAssetInput, options: GaussianSplatAddOptions): Promise<GaussianSplatHandle>;
  remove(handle: GaussianSplatHandle): boolean;
  setVisible(handle: GaussianSplatHandle, visible: boolean): boolean;
  setPlacement(handle: GaussianSplatHandle, placement: GaussianSplatPlacement): Promise<boolean>;
  getBounds(handle?: GaussianSplatHandle): GaussianSplatBounds | null;
  getState(handle: GaussianSplatHandle): GaussianSplatState;
  getStats(): GaussianSplatStats;
  clear(): void;
}
