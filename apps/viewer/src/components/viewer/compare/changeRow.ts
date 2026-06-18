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
import type { DiffState } from '@ifc-lite/diff';

/** One row in the compare results list. */
export interface CompareRow {
  key: string;
  ifcType: string;
  name: string;
  state: DiffState;
  changeKinds: string[];
  ref: CompareRef;
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
