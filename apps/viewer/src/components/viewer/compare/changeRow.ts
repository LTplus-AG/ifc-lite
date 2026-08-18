/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared row shape + text helpers for the Compare panel UI (issue #924),
 * extracted from ComparePanel so the panel stays under the module-size house
 * rule (AGENTS.md).
 */

import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { isRetiringMatch } from '@/lib/compare/contentMatches';
import type { ChangeDetail } from '@/lib/compare/describeChange';
import type {
  ContentMatch,
  ContentMatchKind,
  DiffCounts,
  DiffEntry,
  DiffState,
} from '@ifc-lite/diff';

/**
 * Cap rows RENDERED per group so a huge diff can't stall the DOM.
 *
 * Applies to the Added/Changed/Deleted buckets (`ComparePanel`) and, since
 * #1891, to the Matched / Needs review sections (`CompareMatchGroups`) - the
 * content pass is on by default and a from-scratch re-export can produce one
 * match per element, so that list is the one most likely to be enormous.
 *
 * Display-only in both places: the group counts and the section-header "select
 * all in 3D" action always cover the FULL set, and the overflow is reported as
 * "+N more not shown" so a subset is never shown silently.
 */
export const MAX_ROWS_PER_GROUP = 1000;

/** One row in the compare results list. */
export interface CompareRow {
  key: string;
  ifcType: string;
  name: string;
  state: DiffState;
  changeKinds: string[];
  ref: CompareRef;
}

/**
 * One row in the compare panel's content-match lists (#1891).
 *
 * A content match is NOT a `DiffEntry`: it lives on `diff.contentMatches` and,
 * for the retiring kinds, its entities were deliberately removed from
 * `diff.entries`. So this is a separate row shape rather than a filter over
 * {@link CompareRow} - there is nothing in `entries` left to filter.
 */
export interface CompareMatchRow {
  /**
   * Row identity. Prefixed so it can never collide with a `DiffEntry.key`
   * (a GlobalId or a `missing:` synthetic), because the panel stores the
   * focused row in the single `compareSelectedKey` channel that also feeds
   * `diff.byKey` lookups.
   */
  key: string;
  kind: ContentMatchKind;
  /** Whether the engine retired this match's add/delete entries. */
  retiring: boolean;
  ifcType: string;
  name: string;
  /** How many entities the match holds per side (1 each for a simple pair). */
  baseCount: number;
  headCount: number;
  /** Bounding-box-centre displacement, when the engine could compute one. */
  distance?: number;
  /** Federation global ids to select in 3D when the row is clicked. */
  refs: CompareRef[];
}

/**
 * Turn the engine's content matches into panel rows.
 *
 * `nameOf` resolves a display name from the per-model store (the engine result
 * carries only type + key), kept as a callback so this module stays free of
 * store imports and unit-testable.
 *
 * Retiring matches select their HEAD copies in 3D: the base copies are hidden
 * by the overlay, so selecting them would frame the camera on nothing. Review
 * groups select every candidate on both sides - the whole point of the group is
 * that the user has to look at all of them to resolve it.
 */
export function contentMatchRows(
  matches: readonly ContentMatch<CompareRef>[] | undefined,
  nameOf: (ref: CompareRef) => string,
): CompareMatchRow[] {
  const rows: CompareMatchRow[] = [];
  (matches ?? []).forEach((match, index) => {
    const retiring = isRetiringMatch(match.kind);
    const sample = match.head[0] ?? match.base[0];
    if (!sample) return; // an empty match record carries nothing to show
    const refs = retiring
      ? match.head.map((f) => f.ref)
      : [...match.base.map((f) => f.ref), ...match.head.map((f) => f.ref)];
    rows.push({
      key: `match:${index}`,
      kind: match.kind,
      retiring,
      ifcType: sample.ifcType || 'IfcProduct',
      name: nameOf(sample.ref),
      baseCount: match.base.length,
      headCount: match.head.length,
      distance: match.distance,
      refs,
    });
  });
  return rows;
}

/**
 * Does this comparison have anything to show? THE signal for that question, so
 * the two places that ask it cannot drift apart: `ComparePanel`'s "Download
 * report" bar renders when it is true, and `CompareResultsList`'s "the models
 * match" empty state renders when it is false. They are exact negations of each
 * other, and previously each derived that independently - one could offer a
 * report over a panel claiming the models matched.
 *
 * Counts the content-match ROWS, not `contentMatchCounts(...).total`: rows are
 * what the panel actually lists and what the report actually exports, and
 * {@link contentMatchRows} drops a match record carrying no entities. Note that
 * `counts` alone cannot answer this - a retiring match REMOVED its pair's
 * `added`/`deleted` entries, so a comparison can be all-zero in `counts` and
 * still be full of findings.
 */
export function hasReportableChanges(
  counts: DiffCounts,
  matchRows: readonly CompareMatchRow[],
): boolean {
  return counts.added + counts.modified + counts.deleted + matchRows.length > 0;
}

/** An IFC class present among the changes, with how many changes it drives -
 *  the options feeding the "ignore a class" picker (#1470). */
export interface ChangedTypeCount {
  type: string;
  count: number;
}

/** Tally the classes among the changed (added/modified/deleted) entries, most
 *  changed first. Excluded classes are already absent from `entries`, so they
 *  never appear here. */
export function changedTypeCounts(
  entries: readonly DiffEntry<CompareRef>[],
): ChangedTypeCount[] {
  const tally = new Map<string, number>();
  for (const entry of entries) {
    if (entry.state === 'unchanged') continue;
    const ifcType = (entry.head ?? entry.base)?.ifcType ?? 'IfcProduct';
    tally.set(ifcType, (tally.get(ifcType) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** A short human change label for a row (added / deleted / the change kinds). */
export function changeLabel(row: CompareRow): string {
  if (row.state === 'added') return 'added';
  if (row.state === 'deleted') return 'deleted';
  return row.changeKinds.length ? row.changeKinds.join(' + ') : 'changed';
}

/** Pre-fill a BCF topic title + description from a detected change (#1199). */
export function bcfTextFromChange(
  row: CompareRow,
  detail: ChangeDetail | null,
): { title: string; description: string } {
  const typeLabel = row.ifcType.replace(/^Ifc/, '');
  const name = row.name || typeLabel;
  const title = `${typeLabel} "${name}" - ${changeLabel(row)}`;
  // `null` marks a line to be OMITTED entirely (filtered out below); `''`
  // is reserved for an intentional blank separator (e.g. before "Data
  // changes:"). The two must not share a value - see the filter comment.
  const lines: (string | null)[] = [
    `Detected in model comparison: ${changeLabel(row)}.`,
    row.key.startsWith('missing:') ? null : `GlobalId: ${row.key}`,
  ];
  if (detail?.geometry) {
    if (detail.geometry.movedDistance > 0) lines.push(`Moved ${detail.geometry.movedDistance.toFixed(3)} m.`);
    if (detail.geometry.reshaped) lines.push('Bounding box reshaped.');
  }
  if (detail?.data?.length) {
    lines.push('', 'Data changes:');
    for (const d of detail.data.slice(0, 20)) {
      const where = d.group ? `${d.group} / ${d.name}` : d.name;
      if (d.kind === 'changed') lines.push(`- ${where}: ${d.before ?? '-'} -> ${d.after ?? '-'}`);
      else if (d.kind === 'added') lines.push(`- ${where}: added ${d.after ?? ''}`.trimEnd());
      else lines.push(`- ${where}: removed`);
    }
    if (detail.data.length > 20) lines.push(`- ... and ${detail.data.length - 20} more`);
  }
  // Only `null` lines (omitted rows, e.g. the missing-key GlobalId) are
  // dropped here; a real `''` separator (see the "Data changes:" push
  // above) survives so its blank line stays in the output.
  return { title, description: lines.filter((l): l is string => l !== null).join('\n') };
}
