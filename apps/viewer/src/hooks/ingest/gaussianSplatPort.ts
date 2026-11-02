/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NormalizedGaussianAttributes, Renderer } from '@ifc-lite/renderer';

/**
 * The #8564 native adapter surface this loader consumes (`renderer.gaussianSplats`).
 * Mirrored structurally until @ifc-lite/renderer exports these types; names,
 * states and ownership rules are the renderer's, not a viewer substitute.
 * A renderer without the accessor cannot admit a capture: there is no upload stub.
 */
export interface GaussianSplatPlacement {
  /** Column-major 4x4, source-local -> viewer world (Y-up). Identity: raw source coordinates. */
  readonly matrix: Float64Array | readonly number[];
}
export interface GaussianSplatAssetInput {
  readonly attributes: NormalizedGaussianAttributes;
  readonly placement: GaussianSplatPlacement;
  readonly modelIndex: number;
  readonly visible?: boolean;
}
export interface GaussianSplatAddOptions {
  readonly qualification: 'internal-unqualified';
  readonly signal?: AbortSignal;
}
/** Opaque and renderer-issued: validated by object identity, never rebuilt from its numbers. */
export interface GaussianSplatHandle { readonly id: number; readonly modelIndex: number }
export type GaussianSplatState =
  | { readonly state: 'pending' }
  | { readonly state: 'resident' }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'invalid' };
/** Gaussian CENTRES in renderer world coordinates, for framing only. */
export interface GaussianSplatBounds { readonly min: [number, number, number]; readonly max: [number, number, number] }

export interface GaussianSplatApi {
  /** Success transfers ownership of `attributes`; a rejection retains nothing. */
  add(input: GaussianSplatAssetInput, options: GaussianSplatAddOptions): Promise<GaussianSplatHandle>;
  remove(handle: GaussianSplatHandle): boolean;
  setVisible(handle: GaussianSplatHandle, visible: boolean): boolean;
  setPlacement(handle: GaussianSplatHandle, placement: GaussianSplatPlacement): Promise<boolean>;
  getBounds(handle?: GaussianSplatHandle): GaussianSplatBounds | null;
  getState(handle: GaussianSplatHandle): GaussianSplatState;
}

/** The renderer's adapter, or undefined when this build has none. */
export function gaussianSplatsOf(renderer: Renderer): GaussianSplatApi | undefined {
  return (renderer as Renderer & { readonly gaussianSplats?: GaussianSplatApi }).gaussianSplats;
}
