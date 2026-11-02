/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lazy boundaries of the Gaussian adapter (#8564). luma, packing and placement
 * (which evaluates upstream's SH basis) load with the first Gaussian call, so
 * IFC-only sessions never fetch them.
 */

import type { GaussianBackendFactory } from './gaussian-backend.js';

export const loadLumaBackend: GaussianBackendFactory = async (...args) =>
  (await import('./gaussian-luma-backend.js')).createLumaGaussianBackend(...args);

type GaussianOps = typeof import('./gaussian-pack.js') & typeof import('./gaussian-placement.js');
let ops: Promise<GaussianOps> | null = null;
export const loadGaussianOps = (): Promise<GaussianOps> =>
  (ops ??= Promise.all([import('./gaussian-pack.js'), import('./gaussian-placement.js')]).then(([pack, placement]) => ({ ...pack, ...placement })));
