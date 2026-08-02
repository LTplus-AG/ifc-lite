/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  ContentMatch,
  ContentMatchKind,
  DiffChangeKind,
  DiffCounts,
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

/** Union of component keys whose sub-hash differs (one-sided keys count). */
function changedComponentKeys(
  base: Record<string, string>,
  head: Record<string, string>,
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(base)) {
    if (base[key] !== head[key]) changed.push(key);
  }
  for (const key of Object.keys(head)) {
    if (!(key in base)) changed.push(key);
  }
  return changed.sort();
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
 * Bucket key for the content pass.
 *
 * {@link EntityFingerprint.dataHash} alone is a 32-bit FNV-1a hex string
 * (`stableHash`), and collisions between genuinely different content are
 * reachable rather than theoretical — `content-match.test.ts` pins three real
 * ones. The exposure grows with the square of the number of distinct
 * fingerprints compared, and a from-scratch re-export leaves the whole model
 * unpaired. Pairing on `dataHash` alone would retire a real `added` and a real
 * `deleted` entry in favour of a fabricated `renamed`/`moved`.
 *
 * Folding `ifcType` in as plaintext costs nothing and cannot reject a real
 * match: `buildDataFingerprint` already hashes `ifcType` as part of its
 * payload, so equal content implies equal `ifcType`. A disagreement therefore
 * *proves* the shared `dataHash` was a collision.
 */
function contentBucketKey<TRef>(entity: EntityFingerprint<TRef>): string {
  // NUL separator: `ifcType` is an IFC class name and never contains one, so
  // no ifcType/dataHash pair can be confused with another.
  return `${entity.ifcType}\u0000${entity.dataHash}`;
}

/**
 * Whether the two sides' component sub-hashes agree.
 *
 * Like the `ifcType` check in {@link contentBucketKey}, this cannot reject a
 * real match — {@link EntityFingerprint.components} hashes slices of the same
 * content `dataHash` hashes whole — so a disagreement proves a collision.
 *
 * It does *not* make the pass collision-proof, and the asymmetry is worth
 * knowing: FNV-1a's per-character update is a bijection on the 32-bit state,
 * so two entities differing only inside `attr:core` (a different `Name`, all
 * else equal) hash their whole payloads as `prefix + name + identical suffix`
 * — a `dataHash` collision there *implies* an `attr:core` collision, and this
 * check abstains. It bites when the differing content lands in a pset/qset
 * slice, whose sub-hash is computed over an unrelated string. Closing the gap
 * for real means widening `stableHash`, which changes every published
 * fingerprint.
 *
 * One side missing them is not evidence either way (components are opt-in, and
 * a caller may supply them for one revision only), so this mirrors the
 * `changedComponents` guard in the key-based pass and abstains.
 */
function componentsAgree(
  base: Record<string, string> | undefined,
  head: Record<string, string> | undefined,
): boolean {
  if (!base || !head) return true;
  const baseKeys = Object.keys(base);
  if (baseKeys.length !== Object.keys(head).length) return false;
  for (const key of baseKeys) {
    if (base[key] !== head[key]) return false;
  }
  return true;
}

function pushTo<TRef>(map: Map<string, DiffEntry<TRef>[]>, key: string, entry: DiffEntry<TRef>): void {
  const list = map.get(key);
  if (list) {
    list.push(entry);
  } else {
    map.set(key, [entry]);
  }
}

/**
 * Second matching pass for issue #1891: content-keyed matching of the
 * entities the key-based pass classified as `added`/`deleted`.
 *
 * Buckets leftover `added`/`deleted` entries by {@link contentBucketKey}
 * (`ifcType` + {@link EntityFingerprint.dataHash}).
 *
 * - A bucket with exactly one entity on each side is an unambiguous content
 *   match: `renamed` (geometry hash also agrees, or geometry is out of scope)
 *   or `moved` (it doesn't). The `added`/`deleted` pair is removed from
 *   `entries`/`counts` in favor of a single {@link ContentMatch} — but only
 *   once {@link componentsAgree} has ruled out a `dataHash` collision, since
 *   this is the one destructive path in the pass.
 * - A bucket with more than one entity on either side is ambiguous — no
 *   principled 1:1 pairing exists (see #1923 for what silently guessing looks
 *   like) — so it is left untouched in `entries` and reported *only* as a
 *   {@link ContentMatch} group for the caller to resolve. Nothing is retired
 *   there, so a collision that lands in such a bucket costs the caller an
 *   extra candidate to look at rather than a lost entry.
 *
 * `considerGeometry` is the caller's {@link DiffScope} choice: under
 * `scope: 'data'` geometry is excluded from the comparison, so a
 * geometry-derived `moved` would report a difference the caller explicitly
 * opted out of seeing, and every 1:1 match is reported as `renamed`.
 *
 * `DiffState`/`DiffEntry` are never widened by this pass: it only removes
 * entries or leaves them alone, so downstream code that exhaustively
 * switches over `DiffState` needs no changes.
 *
 * Pure: never mutates its inputs.
 */
function applyContentMatching<TRef>(
  entries: DiffEntry<TRef>[],
  counts: DiffCounts,
  considerGeometry: boolean,
): { entries: DiffEntry<TRef>[]; counts: DiffCounts; contentMatches: ContentMatch<TRef>[] } {
  const addedByHash = new Map<string, DiffEntry<TRef>[]>();
  const deletedByHash = new Map<string, DiffEntry<TRef>[]>();

  for (const entry of entries) {
    if (entry.state === 'added' && entry.head) {
      pushTo(addedByHash, contentBucketKey(entry.head), entry);
    } else if (entry.state === 'deleted' && entry.base) {
      pushTo(deletedByHash, contentBucketKey(entry.base), entry);
    }
  }

  const toRemove = new Set<DiffEntry<TRef>>();
  const contentMatches: ContentMatch<TRef>[] = [];
  let removedAdded = 0;
  let removedDeleted = 0;

  for (const [bucketKey, headGroup] of addedByHash) {
    const baseGroup = deletedByHash.get(bucketKey);
    if (!baseGroup || baseGroup.length === 0) continue;

    // Every entry in these buckets carries the fingerprint its state implies
    // (added ⇒ `head`, deleted ⇒ `base`), so this reads the bucket's shared
    // `dataHash` off the first head entity rather than re-deriving it.
    const dataHash = headGroup[0]?.head?.dataHash;
    if (dataHash === undefined) continue;

    if (baseGroup.length === 1 && headGroup.length === 1) {
      const baseEntry = baseGroup[0];
      const headEntry = headGroup[0];
      const baseFp = baseEntry.base;
      const headFp = headEntry.head;
      // Guaranteed by the state check above (added always carries `head`,
      // deleted always carries `base`); guard anyway rather than asserting.
      if (!baseFp || !headFp) continue;

      // Retiring the pair destroys a real `added` and a real `deleted` if the
      // 32-bit `dataHash` collided. Component sub-hashes, when the caller
      // supplied them, catch part of that — see {@link componentsAgree} for
      // which part, and which it provably cannot.
      if (!componentsAgree(baseFp.components, headFp.components)) continue;

      toRemove.add(baseEntry);
      toRemove.add(headEntry);
      removedAdded++;
      removedDeleted++;

      const kind: ContentMatchKind =
        !considerGeometry || geometryEqual(baseFp.geometryHash, headFp.geometryHash)
          ? 'renamed'
          : 'moved';
      contentMatches.push({ kind, dataHash, base: [baseFp], head: [headFp] });
      continue;
    }

    // Ambiguous: more than one candidate on at least one side. Report the
    // group; the original added/deleted entries stay as-is.
    const kind: ContentMatchKind =
      baseGroup.length === 1 ? 'duplicated' : headGroup.length === 1 ? 'deduplicated' : 'ambiguous';
    const base: EntityFingerprint<TRef>[] = [];
    for (const entry of baseGroup) if (entry.base) base.push(entry.base);
    const head: EntityFingerprint<TRef>[] = [];
    for (const entry of headGroup) if (entry.head) head.push(entry.head);
    contentMatches.push({ kind, dataHash, base, head });
  }

  if (toRemove.size === 0) {
    return { entries, counts, contentMatches };
  }

  const nextEntries = entries.filter((entry) => !toRemove.has(entry));
  const nextCounts: DiffCounts = {
    ...counts,
    added: counts.added - removedAdded,
    deleted: counts.deleted - removedDeleted,
  };

  return { entries: nextEntries, counts: nextCounts, contentMatches };
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
    if (considerGeometry && !geometryEqual(baseEntity.geometryHash, headEntity.geometryHash)) {
      changeKinds.push('geometry');
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

  if (!options.matchUnpairedByContent) {
    return { scope, excludedTypes: excluded ? [...excluded].sort() : [], entries, byKey, counts };
  }

  const matched = applyContentMatching(entries, counts, considerGeometry);
  const matchedByKey = new Map<string, DiffEntry<TRef>>();
  for (const entry of matched.entries) matchedByKey.set(entry.key, entry);

  return {
    scope,
    excludedTypes: excluded ? [...excluded].sort() : [],
    entries: matched.entries,
    byKey: matchedByKey,
    counts: matched.counts,
    contentMatches: matched.contentMatches,
  };
}
