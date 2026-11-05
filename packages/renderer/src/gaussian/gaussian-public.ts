/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Gaussian surface @ifc-lite/renderer exports (#8564). Consumer: the viewer's canonical loader.
export { normalizeGaussianAttributes, type GaussianAttributeSource, type NormalizedGaussianAttributes } from './gaussian-attributes.js';
export type { GaussianBlocker, GaussianCapability, GaussianReadiness } from './gaussian-readiness.js';
export { GaussianSplatError, type GaussianSplatErrorCode } from './gaussian-errors.js';
export type {
  GaussianComposition, GaussianCompositionFallback, GaussianCompositionMode, GaussianCompositionReport, GaussianTransparentLayers,
} from './gaussian-composition.js';
export type {
  GaussianSplatAddOptions, GaussianSplatApi, GaussianSplatAssetInput, GaussianSplatBounds, GaussianSplatHandle,
  GaussianSplatPlacement, GaussianSplatState, GaussianSplatStats,
} from './gaussian-types.js';

export { positionedGaussianChunks } from './gaussian-export.js';
