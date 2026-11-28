/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared storey lookup for per-entity rules and the bulk iteration prefilter. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreyRule } from './filter-rules.js';

// ── Storey lookup fallback ────────────────────────────────────────────────────

/**
 * Storey id an element belongs to: `elementToStorey`, which the parser fills
 * for an element the storey contains directly, an element contained in a
 * space (or nested space) the storey aggregates, and the aggregated parts of
 * either (#11468), OR, one hop through a containing `IfcSpace` /
 * `IfcSpatialZone`, the storey that space belongs to. The hop covers a
 * hierarchy that maps the space but not its elements. The single home for
 * "which storey" so the per-entity evaluator (`defaultStoreyName` /
 * `storeyMatchesRefs`) and the bulk index prefilter (`unionByStorey`) cannot
 * answer it two different ways.
 */
function storeyIdOf(hierarchy: NonNullable<IfcDataStore['spatialHierarchy']>, expressId: number): number | undefined {
  const direct = hierarchy.elementToStorey.get(expressId);
  if (direct !== undefined) return direct;
  // `getContainingSpace` is part of the `spatialLookups()` contract every
  // real hierarchy carries, but several tests in this suite build a
  // hand-rolled partial `spatialHierarchy` mock (`byStorey`/`elementToStorey`
  // only) to exercise the ref/name-matching paths in isolation — guard
  // rather than assume every field is present.
  const spaceId = hierarchy.getContainingSpace?.(expressId);
  if (spaceId == null) return undefined;
  return hierarchy.elementToStorey.get(spaceId);
}

/** Every element {@link storeyIdOf} can resolve to one of `storeyIds`, for
 *  the bulk prefilter: each storey's `byStorey` list, every `elementToStorey`
 *  entry naming one, and every element `bySpace` lists for a space belonging
 *  to one (the one-hop widening). One pass over each map, whatever the number
 *  of storeys. `elementToStorey` and `bySpace` are absent on the same partial
 *  test mocks {@link storeyIdOf} guards against. */
function elementsOfStoreys(hierarchy: NonNullable<IfcDataStore['spatialHierarchy']>, storeyIds: ReadonlySet<number>): number[] | null {
  if (storeyIds.size === 0) return null;
  const out = new Set<number>();
  for (const storeyId of storeyIds) for (const id of hierarchy.byStorey.get(storeyId) ?? []) out.add(id);
  const storeyOf = hierarchy.elementToStorey ?? new Map<number, number>();
  for (const [id, storey] of storeyOf) if (storeyIds.has(storey)) out.add(id);
  for (const [spaceId, elements] of hierarchy.bySpace ?? []) {
    const storey = storeyOf.get(spaceId);
    if (storey === undefined || !storeyIds.has(storey)) continue;
    for (const id of elements) out.add(id);
  }
  return out.size > 0 ? [...out] : null;
}

export function defaultStoreyName(store: IfcDataStore, expressId: number): string {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return '';
  const storeyId = storeyIdOf(hierarchy, expressId);
  if (!storeyId) return '';
  return store.entities.getName(storeyId);
}

/** Does `expressId` (in `modelId`) sit in a storey ref'd by `rule.refs`?
 *  `IfcBuildingStorey.Name` isn't unique, so once a `StoreyRule` carries
 *  an exact (modelId, expressId) ref (mirrored from a HierarchyPanel
 *  click), matching bypasses Name entirely. Reaches through a containing
 *  space via {@link storeyIdOf}, same as the Name-matched path. */
export function storeyMatchesRefs(store: IfcDataStore, expressId: number, modelId: string, rule: StoreyRule): boolean {
  const hierarchy = store.spatialHierarchy;
  const storeyId = hierarchy ? storeyIdOf(hierarchy, expressId) : undefined;
  return storeyId != null && !!rule.refs?.some((r) => r.modelId === modelId && r.expressId === storeyId);
}

/** Index-prefilter twin of {@link storeyMatchesRefs}/Name matching: the
 *  bucket of elements a `storey op:'in'` rule narrows to for `modelId`.
 *  Built from {@link elementsOfStoreys}, so this prefilter can never exclude
 *  a candidate the per-entity check in `filter-evaluate.ts` would match. */
export function unionByStorey(store: IfcDataStore, rule: StoreyRule, modelId: string | undefined): number[] | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const storeyIds = new Set<number>();
  if (rule.refs) {
    for (const ref of rule.refs) if (ref.modelId === modelId) storeyIds.add(ref.expressId);
  } else {
    const wanted = new Set(rule.values.map((n) => n.toLowerCase()));
    for (const storeyId of hierarchy.byStorey.keys()) {
      if (wanted.has(store.entities.getName(storeyId).toLowerCase())) storeyIds.add(storeyId);
    }
  }
  return elementsOfStoreys(hierarchy, storeyIds);
}
