/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared storey lookup for per-entity rules and the bulk iteration prefilter. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreyRule } from './filter-rules.js';

// ── Storey lookup fallback ────────────────────────────────────────────────────

/**
 * Storey id an element belongs to: its own direct containment
 * (`elementToStorey`, set for an element the storey directly contains plus
 * its `IfcRelAggregates`-aggregated parts) OR — one hop through a
 * containing `IfcSpace`/`IfcSpatialZone` — the storey THAT space belongs
 * to. A space is itself mapped to its storey in `elementToStorey`
 * (`SpatialHierarchyBuilder` walks a storey's own spatial children), so
 * this is a composition of two maps that already exist plus
 * `getContainingSpace` (`@ifc-lite/data`'s `spatialLookups`), not a new
 * traversal. The single home for "which storey" so the per-entity
 * evaluator (`defaultStoreyName`/`storeyMatchesRefs`) and the bulk index
 * prefilter (`unionByStorey`) cannot answer it two different ways.
 *
 * Reaches exactly one level down from the storey: an element inside a
 * space nested inside another space (rather than directly under the
 * storey) is not resolved — see `docs/guide/selector-syntax.md`.
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

/** Every element `bySpace` lists for a space belonging to `storeyId` — the
 *  bulk-prefilter twin of {@link storeyIdOf}'s one-hop space widening.
 *  `bySpace` is absent on the same partial test mocks {@link storeyIdOf}
 *  guards against. */
function spaceElementsOfStorey(hierarchy: NonNullable<IfcDataStore['spatialHierarchy']>, storeyId: number): number[] {
  const out: number[] = [];
  if (!hierarchy.bySpace) return out;
  for (const [spaceId, elements] of hierarchy.bySpace) {
    if (hierarchy.elementToStorey.get(spaceId) !== storeyId) continue;
    for (const id of elements) out.push(id);
  }
  return out;
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
 *  Includes each matched storey's directly-contained elements AND every
 *  element `bySpace` lists for a space belonging to that storey, so this
 *  prefilter can never exclude a candidate the (also widened) per-entity
 *  check in `filter-evaluate.ts` would go on to match. */
export function unionByStorey(store: IfcDataStore, rule: StoreyRule, modelId: string | undefined): number[] | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const out: number[] = [];
  if (rule.refs) {
    for (const ref of rule.refs) {
      if (ref.modelId !== modelId) continue;
      const elements = hierarchy.byStorey.get(ref.expressId);
      if (elements) for (const id of elements) out.push(id);
      for (const id of spaceElementsOfStorey(hierarchy, ref.expressId)) out.push(id);
    }
    return out.length > 0 ? out : null;
  }
  const wanted = new Set(rule.values.map((n) => n.toLowerCase()));
  for (const storeyId of hierarchy.byStorey.keys()) {
    const name = store.entities.getName(storeyId);
    if (!wanted.has(name.toLowerCase())) continue;
    const elements = hierarchy.byStorey.get(storeyId);
    if (elements) for (const id of elements) out.push(id);
    for (const id of spaceElementsOfStorey(hierarchy, storeyId)) out.push(id);
  }
  return out.length > 0 ? out : null;
}

