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
 * Storey offsets become per-entity targets, which are diffed against the
 * renderer's previously applied per-entity Y before translation. That makes
 * both mode toggles and live containment edits reversible without reloading.
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
  currentElevations?: ReadonlyMap<number, number>,
): StoreyOffsets {
  if (!dataStore || !Number.isFinite(gap) || gap <= 0) return new Map();
  const elevations = currentElevations ?? dataStore.spatialHierarchy?.storeyElevations;
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
 * The desired Y lift for each entity. The optional membership map is the
 * current session's spatial graph; without it, the parsed reverse index is
 * the fast path for a source-only session.
 */
export function buildEntityLevelOffsets(
  dataStore: IfcDataStore | undefined,
  offsetsByStorey: StoreyOffsets,
  toGlobalId: (localExpressId: number) => number,
  currentMembers?: ReadonlyMap<number, readonly number[]>,
): Map<number, number> {
  const out = new Map<number, number>();
  if (!dataStore || offsetsByStorey.size === 0) return out;
  if (currentMembers) {
    for (const [storeyId, ids] of currentMembers) {
      const dy = offsetsByStorey.get(storeyId);
      if (dy === undefined || dy === 0) continue;
      for (const id of ids) out.set(toGlobalId(id), dy);
    }
    return out;
  }
  // @raw-entity-enumeration-ok no current membership map means this model has no pending mutation view
  const elementToStorey = dataStore.spatialHierarchy?.elementToStorey;
  if (!elementToStorey) return out;
  for (const [elementId, storeyId] of elementToStorey) {
    const dy = offsetsByStorey.get(storeyId);
    if (dy === undefined || dy === 0) continue;
    out.set(toGlobalId(elementId), dy);
  }
  return out;
}

/** Renderer translations needed to reach `target` from what is already applied. */
export function diffEntityLevelOffsets(
  target: ReadonlyMap<number, number>,
  previous: ReadonlyMap<number, number>,
): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  for (const [id, oldY] of previous) {
    const delta = (target.get(id) ?? 0) - oldY;
    if (delta !== 0) out.set(id, [0, delta, 0]);
  }
  for (const [id, nextY] of target) {
    if (!previous.has(id) && nextY !== 0) out.set(id, [0, nextY, 0]);
  }
  return out;
}
