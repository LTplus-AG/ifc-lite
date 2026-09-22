/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { applyContentMatching } from './content-match.js';
import { changedComponentKeys } from './content-tiers.js';
import { geometryEqual, resolveTolerances, resolveUseGeometry } from './geometry-compare.js';
import { resolveKeyAliases } from './key-aliases.js';
import { detectSplitMerge } from './split-merge.js';
import { detectSuccessors } from './successor-match.js';
import type {
  DiffChangeKind,
  DiffCounts,
  DiffEntry,
  DiffScope,
  EntityFingerprint,
  ModelDiff,
  DiffOptions,
} from './types.js';

/** Canonical form for exclude-set membership: trimmed + upper-cased so a
 *  hand-typed `ifcopeningelement ` still matches the store's `IfcOpeningElement`. */
function normalizeType(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * Build the case-insensitive exclude set from {@link DiffOptions.excludeTypes},
 * dropping empty / whitespace-only names. Returns `null` when nothing is
 * excluded so the hot loop can skip the membership check entirely.
 */
function buildExcludeSet(excludeTypes: Iterable<string> | undefined): Set<string> | null {
  if (!excludeTypes) return null;
  const set = new Set<string>();
  for (const name of excludeTypes) {
    if (typeof name !== 'string') continue;
    const normalized = normalizeType(name);
    if (normalized) set.add(normalized);
  }
  return set.size > 0 ? set : null;
}


/**
 * Does `side` carry *any* geometry hash among the entities that actually
 * participate in the comparison? Feeds {@link resolveUseGeometry}.
 *
 * `excludeTypes` drops an entity from the diff entirely — in either revision —
 * so an excluded entity's hash is no evidence that its side "has geometry":
 * excluding the only class that happened to carry hashes leaves that side with
 * none, and the abstention must see that. The participation rule is exactly the
 * one the classification walk below applies.
 *
 * Early-exits on the first hit and allocates nothing; a side that really does
 * carry hashes usually stops on its first entity.
 */
function sideHasGeometryHash<TRef>(
  side: Map<string, EntityFingerprint<TRef>>,
  otherSide: Map<string, EntityFingerprint<TRef>>,
  isExcluded: (entity: EntityFingerprint<TRef>) => boolean,
): boolean {
  for (const [key, entity] of side) {
    if (entity.geometryHash === undefined) continue;
    if (isExcluded(entity)) continue;
    const counterpart = otherSide.get(key);
    if (counterpart !== undefined && isExcluded(counterpart)) continue;
    return true;
  }
  return false;
}

function indexByKey<TRef>(
  entities: Iterable<EntityFingerprint<TRef>>,
): Map<string, EntityFingerprint<TRef>> {
  const map = new Map<string, EntityFingerprint<TRef>>();
  for (const entity of entities) {
    // First occurrence wins — a well-formed model has unique GlobalIds; if a
    // file repeats one, we classify against its first appearance rather than
    // silently letting a later duplicate shadow it.
    if (!map.has(entity.key)) map.set(entity.key, entity);
  }
  return map;
}

/**
 * Diff two model revisions, classifying every entity (matched by
 * {@link EntityFingerprint.key}, typically the IFC `GlobalId`) as
 * added / modified / deleted / unchanged.
 *
 * Pure and store-agnostic: the caller supplies fingerprints (data hash from
 * `buildDataFingerprint`, geometry hash from the WASM mesh pass). The `scope`
 * option selects whether data differences, geometry differences, or both count
 * as a modification — the "compare data, geometry, or both" toggle. Geometry is
 * additionally skipped when the two revisions disagree on whether they carry
 * geometry hashes at all (see {@link resolveUseGeometry}).
 */
export function diffModels<TRef = unknown>(
  base: Iterable<EntityFingerprint<TRef>>,
  head: Iterable<EntityFingerprint<TRef>>,
  options: DiffOptions = {},
): ModelDiff<TRef> {
  // Coerce an out-of-range scope (untyped JS caller) to 'both' — otherwise both
  // flags would be false and every real modification would read as 'unchanged'.
  const scope: DiffScope =
    options.scope === 'data' || options.scope === 'geometry' || options.scope === 'both'
      ? options.scope
      : 'both';
  const considerData = scope === 'data' || scope === 'both';
  const considerGeometry = scope === 'geometry' || scope === 'both';

  const excluded = buildExcludeSet(options.excludeTypes);
  const isExcluded = (entity: EntityFingerprint<TRef>): boolean =>
    excluded !== null && excluded.has(normalizeType(entity.ifcType));

  const baseByKey = indexByKey(base);
  // Accepted identity claims are applied as key normalization BEFORE anything
  // is classified, so an aliased pair meets on the key path and never becomes
  // an add/delete candidate for the content pass (issue #1891).
  const { headByKey, applied: appliedKeyAliases } = resolveKeyAliases(
    indexByKey(head),
    baseByKey,
    options.keyAliases,
  );

  // Resolve the geometry abstention BEFORE classifying anything: a revision
  // fingerprinted with geometry hashing on, compared against one fingerprinted
  // with it off, would otherwise report every key-matched entity as
  // `modified` / `['geometry']` — the whole model "changed" on a difference
  // between two fingerprinting runs. See `resolveUseGeometry`.
  const useGeometry = resolveUseGeometry(
    considerGeometry,
    sideHasGeometryHash(baseByKey, headByKey, isExcluded),
    sideHasGeometryHash(headByKey, baseByKey, isExcluded),
  );

  const entries: DiffEntry<TRef>[] = [];
  const byKey = new Map<string, DiffEntry<TRef>>();
  const counts: DiffCounts = { added: 0, modified: 0, deleted: 0, unchanged: 0 };

  const push = (entry: DiffEntry<TRef>): void => {
    entries.push(entry);
    byKey.set(entry.key, entry);
    counts[entry.state]++;
  };

  // Deleted + matched: walk base.
  for (const [key, baseEntity] of baseByKey) {
    const headEntity = headByKey.get(key);
    // Blacklist: drop the entity if EITHER revision's class is excluded, so a
    // cross-version re-class (e.g. IfcWall -> IfcWallStandardCase with IfcWall
    // excluded) can't leak it back as a phantom add/delete (issue #1470).
    if (isExcluded(baseEntity) || (headEntity !== undefined && isExcluded(headEntity))) continue;
    if (!headEntity) {
      push({ key, state: 'deleted', changeKinds: [], base: baseEntity });
      continue;
    }

    const changeKinds: DiffChangeKind[] = [];
    if (
      considerData &&
      (baseEntity.ifcType !== headEntity.ifcType || baseEntity.dataHash !== headEntity.dataHash)
    ) {
      changeKinds.push('data');
    }
    if (useGeometry && !geometryEqual(baseEntity.geometryHash, headEntity.geometryHash)) {
      changeKinds.push('geometry');
    }
    // Spatial re-parenting (issue #5214): compared only when BOTH sides
    // resolved a non-empty container and they disagree. A container this
    // adapter could not resolve on either side is not evidence of a move —
    // reporting it as one would false-positive on every entity outside a
    // spatial hierarchy (or on an adapter that never populates `container`)
    // — so, like `successor-match.ts`'s `position` profile, absence is
    // skipped rather than counted (see `EntityFingerprint.container`).
    if (
      considerData &&
      baseEntity.container !== undefined &&
      headEntity.container !== undefined &&
      baseEntity.container !== headEntity.container
    ) {
      changeKinds.push('container');
    }

    const entry: DiffEntry<TRef> = {
      key,
      state: changeKinds.length > 0 ? 'modified' : 'unchanged',
      changeKinds,
      base: baseEntity,
      head: headEntity,
    };
    if (baseEntity.components && headEntity.components) {
      entry.changedComponents = changedComponentKeys(baseEntity.components, headEntity.components);
    }
    push(entry);
  }

  // Added: keys only in head. (Matched keys - including excluded ones - were
  // already handled in the base walk.)
  for (const [key, headEntity] of headByKey) {
    if (baseByKey.has(key)) continue;
    if (isExcluded(headEntity)) continue;
    push({ key, state: 'added', changeKinds: [], head: headEntity });
  }

  const excludedTypes = excluded ? [...excluded].sort() : [];

  if (!options.matchUnpairedByContent) {
    const result: ModelDiff<TRef> = { scope, excludedTypes, entries, byKey, counts };
    if (options.keyAliases) result.appliedKeyAliases = appliedKeyAliases;
    return result;
  }

  // The content pass inherits the same resolved answer rather than re-deriving
  // one, so a mixed-capability comparison cannot abstain in one pass and not
  // the other.
  const tolerances = resolveTolerances(options);
  const matched = applyContentMatching(entries, counts, useGeometry, tolerances);
  const matchedByKey = new Map<string, DiffEntry<TRef>>();
  for (const entry of matched.entries) matchedByKey.set(entry.key, entry);

  const result: ModelDiff<TRef> = {
    scope,
    excludedTypes,
    entries: matched.entries,
    byKey: matchedByKey,
    counts: matched.counts,
    contentMatches: matched.contentMatches,
  };
  if (options.keyAliases) result.appliedKeyAliases = appliedKeyAliases;
  // The fourth stage, on the residue the three above left behind, and ADDITIVE:
  // it reads `matched.entries` and returns claims, so `entries`, `byKey` and
  // `counts` above are already final and stay byte-identical to a run with the
  // option off. It inherits the same resolved `useGeometry`, and unlike the
  // content pass has no non-geometric channel to fall back to — under either
  // abstention it reports nothing rather than guessing from data alone.
  if (options.detectSplitMerge) {
    // Assigned only when the stage actually ran: `undefined` back means the
    // geometry abstention fired, and the field's ABSENCE is what says so. An
    // unconditional assignment would publish `[]` there and tell a caller the
    // detector executed and found nothing.
    const claims = detectSplitMerge(matched.entries, useGeometry, options);
    if (claims) result.splitMerges = claims;
  }
  // The LAST stage (issue #4955), on what split/merge did not bind, so the
  // nearest piece of a split is never offered as the whole's successor. Same
  // additive contract, same abstention, same absent-not-empty rule.
  if (options.detectSuccessors) {
    const bound = new Set<EntityFingerprint<TRef>>();
    for (const claim of result.splitMerges ?? []) {
      bound.add(claim.whole);
      for (const piece of claim.pieces) bound.add(piece);
    }
    const claims = detectSuccessors(matched.entries, useGeometry, bound, options, tolerances);
    if (claims) result.successors = claims;
  }
  return result;
}
