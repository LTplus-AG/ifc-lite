/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure offset math for the Exploded level-display mode.
 *
 * Given a model's spatial hierarchy, computes the Y offset (in
 * world / renderer frame) each storey should receive at a given
 * `gap`. Index 0 stays at its native elevation; subsequent
 * storeys (sorted by elevation ascending) lift by
 * `(index - 0) × gap - elevationDelta` so they end up at
 * `index × gap` relative to the lowest storey's Y.
 *
 * The output is `Map<storeyId, deltaY>` — pure data, no
 * side-effects — so callers can:
 *
 *   1. Compute the target offsets
 *   2. Subtract the previously-applied offsets
 *   3. Push the delta into `pendingMeshTranslations`
 *
 * That subtraction is what makes mode toggles + gap changes
 * reversible without re-loading geometry.
 */

import type { IfcDataStore } from '@ifc-lite/parser';

export type StoreyOffsets = Map<number /* storey express id */, number /* renderer Y offset, m */>;

/**
 * Compute target offsets for `gap` based on the model's spatial
 * hierarchy. Returns an empty map for models with no storeys, or
 * with `gap = 0` (which is Stacked semantics).
 *
 * IFC convention: storey elevations are in the model's storey-
 * local frame (Z-up). The renderer is Y-up, so an IFC elevation
 * `e` translates to renderer Y `e` (the geometry pipeline already
 * applies the swap when meshes are built).
 */
export function computeStoreyOffsets(
  dataStore: IfcDataStore | undefined,
  gap: number,
): StoreyOffsets {
  if (!dataStore || !Number.isFinite(gap) || gap <= 0) return new Map();
  const elevations = dataStore.spatialHierarchy?.storeyElevations;
  if (!elevations || elevations.size === 0) return new Map();

  // Sort storeys by elevation ascending so the lowest storey
  // keeps its native Y and everything above lifts.
  const sorted = [...elevations.entries()].sort((a, b) => a[1] - b[1]);
  const baseElevation = sorted[0][1];
  const out: StoreyOffsets = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const [storeyId, elevation] = sorted[i];
    const targetY = baseElevation + i * gap;
    const offset = targetY - elevation;
    if (offset !== 0) out.set(storeyId, offset);
  }
  return out;
}

/**
 * Diff a target offset map against the previously-applied map.
 * Result: `Map<storeyId, deltaY>` such that
 *
 *   newAppliedY = oldAppliedY + delta = targetY
 *
 * Storeys present in `previous` but not `target` get a delta of
 * `-previous[storeyId]` (they're reverting to Stacked). Storeys
 * in `target` but not `previous` get `+target[storeyId]` (they're
 * lifting fresh). Storeys in both get the difference.
 *
 * Zero deltas are omitted so the caller doesn't push no-ops.
 */
export function diffStoreyOffsets(
  target: StoreyOffsets,
  previous: StoreyOffsets,
): StoreyOffsets {
  const out: StoreyOffsets = new Map();
  for (const [storeyId, prev] of previous) {
    const next = target.get(storeyId) ?? 0;
    const delta = next - prev;
    if (delta !== 0) out.set(storeyId, delta);
  }
  for (const [storeyId, next] of target) {
    if (previous.has(storeyId)) continue;
    if (next !== 0) out.set(storeyId, next);
  }
  return out;
}

/**
 * Resolve every entity in a storey to its globalId for the given
 * model index. Walks `spatialHierarchy.elementToStorey` and
 * filters to entries matching `storeyExpressId`. Returns an empty
 * array when the hierarchy is missing.
 *
 * `toGlobalId` is injected so the helper stays free of
 * FederationRegistry imports (keeps it test-friendly).
 */
export function entitiesInStorey(
  dataStore: IfcDataStore | undefined,
  storeyExpressId: number,
  toGlobalId: (localExpressId: number) => number,
): number[] {
  if (!dataStore) return [];
  const map = dataStore.spatialHierarchy?.elementToStorey;
  if (!map) return [];
  const out: number[] = [];
  for (const [elementId, sid] of map) {
    if (sid !== storeyExpressId) continue;
    out.push(toGlobalId(elementId));
  }
  return out;
}

/**
 * Build a per-entity-globalId translation map for a model from a
 * storey-offset map. Used by the level-display effect to push
 * into `pendingMeshTranslations`. The translation is along world
 * +Y only (storey lift) so the X/Z components are zero.
 *
 * `toGlobalId` is injected for the same reason as above.
 */
export function buildEntityTranslations(
  dataStore: IfcDataStore | undefined,
  offsetsByStorey: StoreyOffsets,
  toGlobalId: (localExpressId: number) => number,
): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  if (!dataStore || offsetsByStorey.size === 0) return out;
  const elementToStorey = dataStore.spatialHierarchy?.elementToStorey;
  if (!elementToStorey) return out;
  for (const [elementId, storeyId] of elementToStorey) {
    const dy = offsetsByStorey.get(storeyId);
    if (dy === undefined || dy === 0) continue;
    out.set(toGlobalId(elementId), [0, dy, 0]);
  }
  return out;
}
