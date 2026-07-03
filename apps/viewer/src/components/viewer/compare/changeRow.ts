/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared row shape + text helpers for the Compare panel UI (issue #924),
 * extracted from ComparePanel so the panel stays under the module-size house
 * rule (AGENTS.md).
 */

import type { CompareRef } from '@/lib/compare/buildFingerprints';
import type { ChangeDetail } from '@/lib/compare/describeChange';
import type { DiffEntry, DiffState } from '@ifc-lite/diff';

/** One row in the compare results list. */
export interface CompareRow {
  key: string;
  ifcType: string;
  name: string;
  state: DiffState;
  changeKinds: string[];
  ref: CompareRef;
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
  const lines: string[] = [
    `Detected in model comparison: ${changeLabel(row)}.`,
    row.key.startsWith('missing:') ? '' : `GlobalId: ${row.key}`,
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
  return { title, description: lines.filter((l, i) => l !== '' || i > 0).join('\n') };
}
