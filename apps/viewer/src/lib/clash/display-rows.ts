/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Clash } from '@ifc-lite/clash';

export interface ClashDisplaySection {
  key: string;
  label: string;
  color?: string;
  items: Clash[];
  manualGroupId?: string;
}

export type ClashDisplayRow =
  | { kind: 'group'; key: string; label: string; color?: string; count: number; manualGroupId?: string }
  | { kind: 'clash'; clash: Clash; manualGroupId?: string }
  | { kind: 'detail'; clash: Clash; manualGroupId?: string };

/** The subset of {@link ClashDisplayRow} rendered as a group header. */
export type ClashGroupRow = Extract<ClashDisplayRow, { kind: 'group' }>;

export function clashDisplayRows(
  sections: readonly ClashDisplaySection[],
  collapsed: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): ClashDisplayRow[] {
  const rows: ClashDisplayRow[] = [];
  for (const section of sections) {
    rows.push({
      kind: 'group', key: section.key, label: section.label, color: section.color,
      count: section.items.length,
      ...(section.manualGroupId ? { manualGroupId: section.manualGroupId } : {}),
    });
    if (collapsed.has(section.key)) continue;
    for (const clash of section.items) {
      const group = section.manualGroupId ? { manualGroupId: section.manualGroupId } : {};
      rows.push({ kind: 'clash', clash, ...group });
      if (expanded.has(clash.id)) rows.push({ kind: 'detail', clash, ...group });
    }
  }
  return rows;
}
