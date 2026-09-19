/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lineage (issue #4955): the durable, 1:k answer to "for old key K, which new
 * keys carry its data forward, and by what relation?"
 *
 * An identity map is 1:1 by contract — identity is not a relation that
 * survives being split — and it stays that way. A downstream system that keyed
 * external data (cost lines, inspection records, room bookings) on GlobalIds
 * needs something wider: when a wall becomes three walls, the data has to go
 * SOMEWHERE, and "orphaned" is one honest answer but not the only one. A
 * lineage entry records the relation the engine (or a reviewer) established
 * and lets the external side pick its own policy: copy to every piece, follow
 * the largest share, or refuse.
 *
 * Four relations, each with a different source in a `ModelDiff`:
 *
 * - `identity` — from a content match the engine COMMITTED to (the same
 *   entries `identityMapFromContentMatches` mints), and from every accepted
 *   non-successor alias the diff was run with, so a replayed lineage does not
 *   erode.
 * - `split` / `merge` — from `ModelDiff.splitMerges`, verbatim: one base to k
 *   heads, or k bases to one head, with the confidence in the reason.
 * - `replaced` — from successor claims a caller passed in as accepted, or an
 *   alias replayed with that successor provenance. The engine never promotes
 *   a suggestion to lineage on its own.
 *
 * Every key appears in at most one entry, on either side. The engine already
 * guarantees that (content matching retires; split/merge resolves conflicts;
 * successors run on what is left), and the sidecar refuses a document where it
 * does not hold — a key with two lineages is a document that has not decided.
 */

import { identityMapFromContentMatches, identityMapFromSuccessors, SUCCESSOR_REASON_PREFIX } from './identity-map.js';
import { compareCodeUnits } from './sidecar-common.js';
import type { ModelDiff, SplitMergeClaim, SuccessorClaim } from './types.js';

export type LineageRelation = 'identity' | 'split' | 'merge' | 'replaced';

/**
 * One lineage entry. `base` and `head` are key lists; exactly one of them has
 * more than one key, and only for `split` (k heads) or `merge` (k bases).
 */
export interface LineageEntry {
  base: string[];
  head: string[];
  relation: LineageRelation;
  /**
   * Provenance: `content-match:<kind>` or `alias:<reason>` for `identity`,
   * `split:<confidence>` / `merge:<confidence>` for those, and
   * `successor:<confidence>` for `replaced`.
   */
  reason: string;
  /**
   * For a `split`, each head key's share of the pieces' total volume, in the
   * order of {@link head}; for a `merge`, each base key's share, in the order
   * of {@link base}. Present only when every piece carried a proved volume
   * (the claim's confidence was not `extent`). The `largest-share` rekey policy
   * reads it; without it only `copy-to-all` and `orphan-on-split` are safe.
   */
  shares?: number[];
}

/**
 * A lineage as {@link rekeyByLineage} consumes it: the entries, plus the
 * base-revision keys the diff left DELETED with no lineage at all. The two
 * together let a rekey tell an unchanged key (no entry, not deleted: the row
 * keeps its key) from a deleted one (orphaned). Without `deleted`, a key with
 * no entry is passed through unchanged — losing a row is the worse failure.
 */
export interface Lineage {
  entries: readonly LineageEntry[];
  deleted?: readonly string[];
}

export interface LineageFromDiffOptions<TRef> {
  /** Successor claims a human accepted; these become `replaced` entries. */
  accepted?: Iterable<SuccessorClaim<TRef>>;
  /**
   * Reasons for the aliases the diff was run with (`appliedKeyAliases`), keyed
   * by head key, so a carried-forward entry keeps its original provenance
   * instead of reading as freshly derived. Absent reasons fall back to
   * `alias:replayed`.
   */
  aliasReasons?: ReadonlyMap<string, string>;
}

function sharesOf<TRef>(claim: SplitMergeClaim<TRef>): number[] | undefined {
  if (claim.confidence === 'extent') return undefined;
  const total = claim.piecesVolume;
  if (total === undefined || !(total > 0)) return undefined;
  const shares: number[] = [];
  for (const piece of claim.pieces) {
    const volume = piece.volume;
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0) return undefined;
    shares.push(volume / total);
  }
  return shares;
}

function compareEntries(a: LineageEntry, b: LineageEntry): number {
  return compareCodeUnits(a.base[0] ?? '', b.base[0] ?? '') || compareCodeUnits(a.head[0] ?? '', b.head[0] ?? '');
}

/**
 * Derive lineage from a diff. Pure; entries are sorted by (first base key,
 * first head key) so the same comparison yields the same list.
 *
 * Applied aliases are carried forward using their provenance: a diff run with
 * a replayed map classifies those pairs by key, so they never reach the
 * content pass and would otherwise vanish from a `--lineage-in x --lineage-out
 * x` round trip, the file shrinking on every run. A `successor:` reason stays
 * `replaced`; all other aliases are `identity`.
 */
export function lineageFromDiff<TRef>(
  diff: ModelDiff<TRef>,
  options: LineageFromDiffOptions<TRef> = {},
): LineageEntry[] {
  return lineageOfDiff(diff, options).entries;
}

/**
 * {@link lineageFromDiff} plus the `deleted` list: every base key the diff still
 * reports as `deleted` and no lineage entry accounts for. This is what a
 * sidecar should carry, so a rekey can orphan those rows and pass every other
 * unmatched key through as unchanged.
 */
export function lineageOfDiff<TRef>(
  diff: ModelDiff<TRef>,
  options: LineageFromDiffOptions<TRef> = {},
): { entries: LineageEntry[]; deleted: string[] } {
  const entries = lineageEntriesOf(diff, options);
  const accounted = new Set<string>();
  for (const entry of entries) for (const key of entry.base) accounted.add(key);
  const deleted: string[] = [];
  for (const entry of diff.entries) {
    if (entry.state === 'deleted' && !accounted.has(entry.key)) deleted.push(entry.key);
  }
  deleted.sort(compareCodeUnits);
  return { entries, deleted };
}

function lineageEntriesOf<TRef>(
  diff: ModelDiff<TRef>,
  options: LineageFromDiffOptions<TRef>,
): LineageEntry[] {
  const entries: LineageEntry[] = [];

  for (const [here, base] of diff.appliedKeyAliases ?? []) {
    const reason = options.aliasReasons?.get(here) ?? 'alias:replayed';
    entries.push({
      base: [base],
      head: [here],
      relation: reason.startsWith(SUCCESSOR_REASON_PREFIX) ? 'replaced' : 'identity',
      reason,
    });
  }
  for (const entry of identityMapFromContentMatches(diff.contentMatches)) {
    entries.push({ base: [entry.base], head: [entry.here], relation: 'identity', reason: entry.reason });
  }
  for (const claim of diff.splitMerges ?? []) {
    const pieces = claim.pieces.map((piece) => piece.key);
    const shares = sharesOf(claim);
    const entry: LineageEntry =
      claim.kind === 'split'
        ? { base: [claim.whole.key], head: pieces, relation: 'split', reason: `split:${claim.confidence}` }
        : { base: pieces, head: [claim.whole.key], relation: 'merge', reason: `merge:${claim.confidence}` };
    if (shares) entry.shares = shares;
    entries.push(entry);
  }
  for (const entry of identityMapFromSuccessors(options.accepted)) {
    entries.push({ base: [entry.base], head: [entry.here], relation: 'replaced', reason: entry.reason });
  }

  return entries.sort(compareEntries);
}

/**
 * Keys that appear in more than one entry on the same side. A lineage is a
 * decided document: a key with two lineages is one that has not decided, and
 * applying either would be an arbitrary winner.
 */
export function lineageConflicts(entries: readonly LineageEntry[]): string[] {
  const problems: string[] = [];
  for (const side of ['base', 'head'] as const) {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const entry of entries) {
      for (const key of entry[side]) {
        if (seen.has(key)) repeated.add(key);
        seen.add(key);
      }
    }
    for (const key of [...repeated].sort(compareCodeUnits)) {
      problems.push(`${side} key "${key}" appears in more than one lineage entry`);
    }
  }
  return problems;
}

/**
 * The 1:1 entries of a lineage as the head-key → base-key map
 * {@link DiffOptions.keyAliases} takes. `split` and `merge` entries are never
 * aliases (identity is 1:1); `identity` and `replaced` are, on exactly the
 * rules `keyAliasesFromSidecar` applies — self-claims dropped, a `here` two
 * entries disagree about dropped entirely.
 */
export function keyAliasesFromLineage(entries: readonly LineageEntry[]): Map<string, string> {
  const claims = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const entry of entries) {
    if (entry.relation !== 'identity' && entry.relation !== 'replaced') continue;
    if (entry.base.length !== 1 || entry.head.length !== 1) continue;
    const here = entry.head[0];
    const base = entry.base[0];
    const claimed = claims.get(here);
    if (claimed === undefined) claims.set(here, base);
    else if (claimed !== base) conflicted.add(here);
  }
  const aliases = new Map<string, string>();
  for (const [here, base] of claims) {
    if (conflicted.has(here) || base === here) continue;
    aliases.set(here, base);
  }
  return aliases;
}

/**
 * What an external table keyed on base-revision keys should do with each row
 * whose element split:
 *
 * - `copy-to-all` — every piece inherits the row.
 * - `largest-share` — only the piece with the largest volume share inherits
 *   it; without `shares` the row is orphaned rather than guessed.
 * - `orphan-on-split` — the row is orphaned; only 1:1 relations rekey.
 *
 * A `merge` always maps every base row onto the one head key, whatever the
 * policy: the data of k elements now describes one.
 */
export type RekeyPolicy = 'copy-to-all' | 'largest-share' | 'orphan-on-split';

export interface RekeyResult {
  /** The base-revision key the caller asked about. */
  key: string;
  /** Head-revision keys the row should now be attached to; empty when orphaned. */
  successors: string[];
  /**
   * The relation that produced the answer. `unchanged` means the key has no
   * lineage entry and is not in the lineage's `deleted` list, so it is
   * matched by key in the head revision and the row keeps it. `undefined`
   * means the key is in the `deleted` list.
   */
  relation?: LineageRelation | 'unchanged';
  /** `true` when the row has nowhere to go: deleted, or a split the policy refused. */
  orphan: boolean;
}

/**
 * Rekey a set of base-revision keys through a lineage. Pure and table-agnostic:
 * the caller applies the answers to its own rows.
 */
export function rekeyByLineage(
  keys: Iterable<string>,
  lineage: Lineage | readonly LineageEntry[],
  policy: RekeyPolicy = 'copy-to-all',
): RekeyResult[] {
  const entries = Array.isArray(lineage) ? (lineage as readonly LineageEntry[]) : (lineage as Lineage).entries;
  const deleted = new Set(Array.isArray(lineage) ? [] : ((lineage as Lineage).deleted ?? []));
  const byBase = new Map<string, LineageEntry>();
  for (const entry of entries) {
    for (const key of entry.base) if (!byBase.has(key)) byBase.set(key, entry);
  }
  const results: RekeyResult[] = [];
  for (const key of keys) {
    const entry = byBase.get(key);
    if (!entry) {
      // A lineage records CHANGES. A key it does not mention was either
      // matched by key (the row keeps it) or deleted with nothing to carry it
      // forward (orphaned); only the `deleted` list can tell the two apart.
      if (deleted.has(key)) results.push({ key, successors: [], orphan: true });
      else results.push({ key, successors: [key], relation: 'unchanged', orphan: false });
      continue;
    }
    if (entry.relation !== 'split') {
      results.push({ key, successors: [...entry.head], relation: entry.relation, orphan: false });
      continue;
    }
    let successors: string[];
    if (policy === 'copy-to-all') {
      successors = [...entry.head];
    } else if (policy === 'largest-share' && entry.shares && entry.shares.length === entry.head.length) {
      let best = 0;
      for (let i = 1; i < entry.shares.length; i++) if (entry.shares[i] > entry.shares[best]) best = i;
      // A tie for the largest share is an abstention, not a first-wins.
      const tied = entry.shares.filter((share) => share === entry.shares![best]).length > 1;
      successors = tied ? [] : [entry.head[best]];
    } else {
      successors = [];
    }
    results.push({ key, successors, relation: 'split', orphan: successors.length === 0 });
  }
  return results;
}
