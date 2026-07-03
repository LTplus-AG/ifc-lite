/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  DiffChangeKind,
  DiffEntry,
  DiffScope,
  EntityFingerprint,
  GeometryHash,
  ModelDiff,
  DiffOptions,
} from './types.js';

/**
 * Compare two geometry fingerprints.
 *
 * - both `undefined`  → equal (neither side has geometry)
 * - one `undefined`   → changed (geometry added or removed)
 * - both present      → equal iff the normalized hashes match
 *
 * `bigint` and `string` hashes are normalized to strings so a `bigint` from
 * the WASM `BigUint64Array` compares equal to its string form.
 */
function geometryEqual(a: GeometryHash | undefined, b: GeometryHash | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

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
 * as a modification — the "compare data, geometry, or both" toggle.
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
  const headByKey = indexByKey(head);

  const entries: DiffEntry<TRef>[] = [];
  const byKey = new Map<string, DiffEntry<TRef>>();
  const counts = { added: 0, modified: 0, deleted: 0, unchanged: 0 };

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
    if (considerGeometry && !geometryEqual(baseEntity.geometryHash, headEntity.geometryHash)) {
      changeKinds.push('geometry');
    }

    push({
      key,
      state: changeKinds.length > 0 ? 'modified' : 'unchanged',
      changeKinds,
      base: baseEntity,
      head: headEntity,
    });
  }

  // Added: keys only in head. (Matched keys - including excluded ones - were
  // already handled in the base walk.)
  for (const [key, headEntity] of headByKey) {
    if (baseByKey.has(key)) continue;
    if (isExcluded(headEntity)) continue;
    push({ key, state: 'added', changeKinds: [], head: headEntity });
  }

  return { scope, excludedTypes: excluded ? [...excluded].sort() : [], entries, byKey, counts };
}
