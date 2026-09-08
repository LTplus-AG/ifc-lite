/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The change report's row shape, and the content-matching rows that do not
 * come from `diff.entries` (issues #1202, #1891). Split out of
 * `exportReport.ts` so both stay under the module-size house rule (AGENTS.md).
 */

import type { ContentMatch, ContentMatchKind, DiffState } from '@ifc-lite/diff';
import type { FederatedModel } from '../../store/types.js';
import type { CompareRef } from './buildFingerprints.js';
import { isRetiringMatch, MATCH_KIND_LABEL } from './contentMatches.js';

/** One row of the exported change report. */
export interface CompareReportRow {
  globalId: string;
  name: string;
  ifcType: string;
  /**
   * Raw diff state: added | deleted | modified, or `matched` for a row that
   * came from `diff.contentMatches` rather than `diff.entries` (#1891). The
   * engine deliberately invented no new `DiffState` for a content match, so
   * this widening happens here, in the report's own vocabulary.
   */
  state: DiffState | 'matched';
  /** Human change label: "Added", "Deleted", "Moved", "Reshaped",
   *  "Data changed", "Renamed", or a combination ("Moved, Data changed"). */
  change: string;
  /** AABB-centre displacement in metres (0 when not a move). */
  movedDistance: number;
  /** Which model this row's element lives in (head for add/modify, base for delete). */
  model: string;
  /**
   * The content-match kind this element participates in, when any (#1891).
   * Set on `matched` rows, and also on the still-present `added`/`deleted`
   * rows of an unresolved group (`duplicated`/`deduplicated`/`ambiguous`) -
   * those retire nothing, so annotating them is how the grouping reaches the
   * report without duplicating a GlobalId across two rows.
   */
  match?: ContentMatchKind;
  /** The counterpart's GlobalId, for a content match that is exactly 1:1.
   *  Blank for a group match: the engine reports the group precisely because
   *  it has no evidence for which member pairs with which. */
  matchedGlobalId?: string;
}

/** A GlobalId string for a report row: synthetic `missing:` keys (entities
 *  without a resolvable GlobalId) export blank rather than the placeholder. */
export function exportedGlobalId(key: string | undefined): string {
  return !key || key.startsWith('missing:') ? '' : key;
}

/**
 * Rows for the content-matching pass (#1891).
 *
 * A `renamed`/`moved`/`reshaped` match REMOVED its pair's `added` + `deleted`
 * entries from `diff.entries`, so without this the elements simply vanish from
 * a coordination CSV: the counts drop and no row says why. One row per head
 * entity keeps the report's unit (one element per row) and keeps every
 * GlobalId resolvable in the file it claims to describe.
 *
 * Unresolved groups (`duplicated`/`deduplicated`/`ambiguous`) retire nothing,
 * so their entities are already present as `added`/`deleted` rows. They get an
 * annotation on those rows instead ({@link annotateReviewGroups}) — emitting a
 * second row would report one element twice.
 */
export function contentMatchReportRows(
  matches: readonly ContentMatch<CompareRef>[],
  models: ReadonlyMap<string, FederatedModel>,
  headName: string,
): CompareReportRow[] {
  const rows: CompareReportRow[] = [];
  for (const match of matches) {
    if (!isRetiringMatch(match.kind)) continue;
    const oneToOne = match.base.length === 1 && match.head.length === 1;
    for (const fingerprint of match.head) {
      const ref = fingerprint.ref;
      rows.push({
        globalId: exportedGlobalId(fingerprint.key),
        name: models.get(ref.modelId)?.ifcDataStore?.entities.getName(ref.localId) || '',
        ifcType: fingerprint.ifcType,
        state: 'matched',
        change: MATCH_KIND_LABEL[match.kind],
        movedDistance: match.distance ?? 0,
        model: headName,
        match: match.kind,
        matchedGlobalId: oneToOne ? exportedGlobalId(match.base[0]?.key) : '',
      });
    }
  }
  return rows;
}

/** Stamp the unresolved-group kind onto the `added`/`deleted` rows the engine
 *  left in place, keyed by federation global id. */
export function annotateReviewGroups(
  rows: CompareReportRow[],
  matches: readonly ContentMatch<CompareRef>[],
  byGlobalId: ReadonlyMap<CompareReportRow, number>,
): void {
  const kindByGlobalId = new Map<number, ContentMatchKind>();
  for (const match of matches) {
    if (isRetiringMatch(match.kind)) continue;
    for (const fingerprint of [...match.base, ...match.head]) {
      kindByGlobalId.set(fingerprint.ref.globalId, match.kind);
    }
  }
  if (kindByGlobalId.size === 0) return;
  for (const row of rows) {
    const globalId = byGlobalId.get(row);
    if (globalId === undefined) continue;
    const kind = kindByGlobalId.get(globalId);
    if (kind) row.match = kind;
  }
}
