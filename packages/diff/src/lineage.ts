/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public declarations; the implementation lives in Rust (#8042).
import type { SuccessorClaim } from './types.js';
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
   *
   * Reasons are provenance, not a schema discriminator: an incoming lineage's
   * explicit relation wins on replay. For aliases coming from an identity map
   * (which has no relation field), `successor:` means `replaced`; every other
   * reason means `identity`.
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
  /** Explicit relations carried by an incoming lineage. A v1 reason is free
   * form, so replay must not infer a different relation from its prefix. */
  aliasRelations?: ReadonlyMap<string, Extract<LineageRelation, 'identity' | 'replaced'>>;
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
