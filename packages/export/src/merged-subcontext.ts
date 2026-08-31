/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Kind-aware `IfcGeometricRepresentationSubContext` matching for
 * {@link MergedExporter} (merge invariant lens pass 3, item 1).
 *
 * `MergedExporter` deduplicates a unit-compatible model's shared
 * infrastructure — `IfcUnitAssignment`, `IfcGeometricRepresentationContext`
 * and subcontexts — onto the primary model's instance. For subcontexts that
 * used to mean taking the two models' subcontext id lists **positionally**:
 * this model's first subcontext (in whatever order `entityIndex.byType`
 * returns them) was unified onto the primary model's first subcontext, with
 * no check that the two are the same kind.
 *
 * A model normally declares more than one subcontext ('Body' for solid
 * geometry, 'Axis' for centreline geometry, sometimes 'FootPrint'/'Box'), and
 * nothing in the IFC schema or common exporter behaviour guarantees they are
 * always written in the same order across two different authoring tools. A
 * positional match can therefore unify this model's 'Body' subcontext onto
 * the primary model's 'Axis' subcontext (or vice versa): every
 * `IfcShapeRepresentation.ContextOfItems` that pointed at the dropped 'Body'
 * subcontext now resolves, after the remap, to a context tagged 'Axis' — the
 * wrong kind, which many viewers filter out of the 3D view entirely (the
 * geometry silently vanishes), with no dangling reference to reveal it.
 *
 * `planSubContextUnify` fixes this by matching on the subcontext's *kind*
 * (its `ContextIdentifier` *and* `TargetView`, plus `UserDefinedTargetView`
 * where applicable) rather than on raw array position.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { asSourceBytes } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

/** 0-based attribute index of `IfcGeometricRepresentationSubContext.ContextIdentifier`. */
const CONTEXT_IDENTIFIER_ATTR = 0;
/** 0-based attribute index of `IfcGeometricRepresentationSubContext.TargetView`. */
const TARGET_VIEW_ATTR = 8;
/** 0-based attribute index of `IfcGeometricRepresentationSubContext.UserDefinedTargetView`. */
const USER_DEFINED_TARGET_VIEW_ATTR = 9;

function decodeEntity(dataStore: IfcDataStore, expressId: number): string | null {
  const source = dataStore.source;
  if (!source) return null;
  const ref = dataStore.entityIndex.byId.get(expressId);
  if (!ref) return null;
  return asSourceBytes(source).decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
}

/** Extract one 0-based STEP attribute of `expressId`'s entity, or null if unreadable. */
function getStepAttr(dataStore: IfcDataStore, expressId: number, index: number): string | null {
  const text = decodeEntity(dataStore, expressId);
  const match = text?.match(/^#\d+\s*=\s*\w+\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) return null;
  const args = splitTopLevelStepArguments(match[1]);
  const raw = args?.[index];
  return raw === undefined ? null : raw.trim();
}

/** Normalize a STEP string/enum token to a comparison key; `''` for unset/unreadable. */
function normalizeLabel(raw: string | null): string {
  if (!raw || raw === '$' || raw === '*') return '';
  const quoted = raw.match(/^'([\s\S]*)'$/);
  const inner = quoted ? quoted[1] : raw;
  return inner.replace(/\./g, '').trim().toUpperCase();
}

/**
 * The matching key of one `IfcGeometricRepresentationSubContext` combines its
 * `ContextIdentifier` and `TargetView`: a Body representation for MODEL_VIEW
 * is not interchangeable with one for PLAN_VIEW. `UserDefinedTargetView`
 * distinguishes two USERDEFINED views. Empty pieces deliberately remain part
 * of the key so identifier-less subcontexts still group by their view.
 */
function subContextKey(dataStore: IfcDataStore, expressId: number): string {
  const identifier = normalizeLabel(getStepAttr(dataStore, expressId, CONTEXT_IDENTIFIER_ATTR));
  const targetView = normalizeLabel(getStepAttr(dataStore, expressId, TARGET_VIEW_ATTR));
  const userDefinedTargetView = targetView === 'USERDEFINED'
    ? normalizeLabel(getStepAttr(dataStore, expressId, USER_DEFINED_TARGET_VIEW_ATTR))
    : '';
  return `${identifier}\u0000${targetView}\u0000${userDefinedTargetView}`;
}

/** Group `ids` (a model's subcontext express ids) by {@link subContextKey}. */
export function groupSubContextsByKey(dataStore: IfcDataStore, ids: readonly number[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const id of ids) {
    const key = subContextKey(dataStore, id);
    const bucket = map.get(key);
    if (bucket) bucket.push(id); else map.set(key, [id]);
  }
  return map;
}

/**
 * Plan this model's subcontext dedup against the primary model, key by key:
 * a subcontext in `thisIds` is remapped+skipped only against an unclaimed
 * primary-model subcontext with the SAME key (never a differently ordered one
 * of a different kind or TargetView). A subcontext with no same-key match in
 * the primary model is left un-remapped — kept as its own (offset-only)
 * entity, exactly like today's "no shared infrastructure of this type"
 * fallback. Mutates `sharedRemap`/`skipEntityIds`.
 */
export function planSubContextUnify(
  dataStore: IfcDataStore,
  thisIds: readonly number[],
  firstModelSubContextsByKey: ReadonlyMap<string, number[]>,
  firstModelOffset: number,
  sharedRemap: Map<number, number>,
  skipEntityIds: Set<number>,
): void {
  const nextIndex = new Map<string, number>();
  for (const id of thisIds) {
    const key = subContextKey(dataStore, id);
    const pool = firstModelSubContextsByKey.get(key);
    if (!pool || pool.length === 0) continue;
    const idx = nextIndex.get(key) ?? 0;
    if (idx >= pool.length) continue; // every same-kind primary target already claimed
    nextIndex.set(key, idx + 1);
    sharedRemap.set(id, pool[idx] + firstModelOffset);
    skipEntityIds.add(id);
  }
}

/**
 * Plan the whole shared-infrastructure dedup for one model — `MergedExporter`
 * delegates its entire "remap and skip duplicate infrastructure" step here so
 * the kind-vs-position distinction lives in one place. Every
 * {@link SHARED_INFRASTRUCTURE_TYPES}-listed type is unified by position
 * EXCEPT `IFCGEOMETRICREPRESENTATIONSUBCONTEXT`, which goes through
 * {@link planSubContextUnify} instead (key-matched). Mutates
 * `sharedRemap`/`skipEntityIds`.
 */
export function planInfrastructureUnify(
  dataStore: IfcDataStore,
  modelInfra: ReadonlyMap<string, number[]>,
  firstModelInfraMap: ReadonlyMap<string, number[]>,
  firstModelSubContextsByKey: ReadonlyMap<string, number[]>,
  firstModelOffset: number,
  sharedRemap: Map<number, number>,
  skipEntityIds: Set<number>,
): void {
  for (const [type, firstIds] of firstModelInfraMap) {
    const thisIds = modelInfra.get(type);
    if (!thisIds || firstIds.length === 0 || thisIds.length === 0) continue;
    if (type === 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT') {
      planSubContextUnify(dataStore, thisIds, firstModelSubContextsByKey, firstModelOffset, sharedRemap, skipEntityIds);
      continue;
    }
    sharedRemap.set(thisIds[0], firstIds[0] + firstModelOffset);
    skipEntityIds.add(thisIds[0]);
  }
}
