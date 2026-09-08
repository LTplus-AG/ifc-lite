/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection that X-Ray must leave solid.
 *
 * The store keeps selection in two channels: `selectedEntityId` for a single
 * pick and `selectedEntityIds` for a multi-select. A plain viewport click sets
 * the scalar and CLEARS the set, so reading only the set misses the most common
 * interaction there is — which is exactly how the Cesium world view came to
 * fade the element the user had just clicked (#2591 review).
 *
 * The renderer folds the two together before deciding exemption
 * (`Renderer.render` builds `selectedExpressIds` from both). This is the same
 * fold, for the consumer that builds its own glTF and cannot borrow that pass.
 * Returns `null` when nothing is selected, so callers can skip the work.
 */
export function ghostExemptSelection(
  selectedEntityId: number | null | undefined,
  selectedEntityIds: ReadonlySet<number> | null | undefined,
): ReadonlySet<number> | null {
  const hasScalar = selectedEntityId != null;
  if (!hasScalar && !selectedEntityIds?.size) return null;
  const merged = new Set<number>(selectedEntityIds ?? []);
  if (hasScalar) merged.add(selectedEntityId);
  return merged;
}
