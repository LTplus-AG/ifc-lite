/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When a raster with no mapped class may be read as "no runoff mapped": only
 * with a rendering confirmation whose reference response was fetched within
 * {@link CONFIRMATION_MAX_AGE_MS} of the raster. A confirmation says the layer
 * rendered when its reference was fetched, nothing about a raster fetched
 * long before or after it (the service may have stopped rendering since, or a
 * cache may hold an answer from an outage).
 */

import { CELL_NO_RUNOFF, CELL_UNCLASSIFIED, type ClassifiedHazardRaster, type RenderingConfirmation } from '../types.js';

/** Largest gap between a rendering confirmation's reference response and the raster it vouches for: 5 minutes. */
export const CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * True when no cell carries a mapped class. Transparent and unreadable
 * (edge-blend) cells alone do not show that the layer renders, so such a
 * raster needs the provider's rendering confirmation like a wholly
 * transparent one.
 */
export function rasterShowsNoClass(raster: Pick<ClassifiedHazardRaster, 'cells' | 'classes'>): boolean {
  for (const c of raster.cells) if (c !== CELL_NO_RUNOFF && c !== CELL_UNCLASSIFIED && c <= raster.classes.length) return false;
  return true;
}

/** Milliseconds between two ISO times; NaN when either does not parse. */
export function msBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b));
}

/** True when the confirmation is positive and its reference was fetched within the maximum age of the raster. */
export function confirmationVouches(confirmation: RenderingConfirmation | null | undefined, rasterRetrievedAt: string): boolean {
  return confirmation?.confirmed === true && msBetween(confirmation.retrievedAt, rasterRetrievedAt) <= CONFIRMATION_MAX_AGE_MS;
}
