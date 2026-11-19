/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { BLOCK_TITLE_HEIGHT, blockTitleStyle } from './block-title';
import { blockTitleItems } from './compose-block-title';
import type { LayoutCursor } from './compose-table';
import type { DrawnItem } from './compose';
import type { ResolvedQualityGate, QualityGateRing } from './quality-gate-block';

export interface QualityGateRingItem extends QualityGateRing {
  kind: 'quality-gate-ring';
  x: number;
  y: number;
  w: number;
  h: number;
}

export function layoutQualityGate(block: ResolvedQualityGate,
  cursor: LayoutCursor & { push: (...items: DrawnItem[]) => void },
  width: number, gap: number, wrap: (text: string, width: number, size: number, bold: boolean) => string[]): void {
  const { x } = cursor;
  const titleHeight = BLOCK_TITLE_HEIGHT + blockTitleStyle(block).extra;
  const fontSize = 10, lineHeight = 14;
  const ringSize = 80;
  const lines = block.lines.flatMap(line => wrap(line, width, fontSize, false));
  cursor.ensure(titleHeight + (block.ring ? ringSize : 0) + Math.min(lines.length, 2) * lineHeight);
  cursor.push(...blockTitleItems(block, block.title, x, cursor.y, width, cursor.truncate));
  cursor.y += titleHeight;
  if (block.ring) {
    cursor.push({ kind: 'quality-gate-ring', ...block.ring, x, y: cursor.y, w: ringSize, h: ringSize });
    cursor.y += ringSize;
  }
  for (const text of lines) {
    cursor.ensure(lineHeight);
    cursor.push({ kind: 'text', x, y: cursor.y + fontSize, size: fontSize, bold: false, gray: 60, text });
    cursor.y += lineHeight;
  }
  cursor.y += gap;
}
