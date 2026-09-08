/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hide/isolate rule, in one place.
 *
 * Every surface that answers "is this element on screen right now" has to give
 * the same answer: flat batches, GPU-instanced occurrences, raycast/picking,
 * and — since #2578 — the Cesium world view, which renders the model through a
 * separate glTF pipeline and so cannot inherit the renderer's per-frame
 * filtering for free. The rule used to be written out at each of those sites,
 * five times, which is exactly how the world view ended up disagreeing with the
 * viewport.
 *
 * Semantics, unchanged from the sites this replaces:
 * - `hiddenIds` is a blocklist; an absent or empty set hides nothing.
 * - `isolatedIds` is an allowlist and is meaningfully nullable: `null` /
 *   `undefined` means "no isolation active, show everything", while an EMPTY
 *   set means "isolate nothing", i.e. hide every element. Do not collapse the
 *   two — `VisibilityEpochTracker` preserves the same distinction.
 * - Hiding wins over isolation: an isolated element that is also hidden stays
 *   hidden.
 *
 * Ids are whatever id space the caller's sets use. In the viewer that is the
 * federated global id for every channel, flat and instanced alike (#1912).
 */
export function isEntityVisible(
  expressId: number,
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): boolean {
  if (hiddenIds != null && hiddenIds.has(expressId)) return false;
  if (isolatedIds != null && !isolatedIds.has(expressId)) return false;
  return true;
}
