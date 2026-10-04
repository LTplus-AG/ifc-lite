/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { REPORT_MARGIN } from '../export/report/compose.js';
import type { DrawnItem } from './compose.js';
import type { LayoutCursor } from './compose-table.js';

export const HEADER_HEIGHT = 30;
export const FOOTER_HEIGHT = 24;

/**
 * Page height a block laid out at `scale` sees (#6548). A scaled block is laid out as if the
 * printable frame were `1 / scale` as tall and wide and then drawn `scale` times larger, so the
 * frame shrinks while the margins, header and footer around it do not.
 */
export function scaledPageHeight(pageHeight: number, headingExtraHeight: number, scale: number): number {
  const fixed = 2 * REPORT_MARGIN + HEADER_HEIGHT + FOOTER_HEIGHT + headingExtraHeight;
  return fixed + (pageHeight - fixed) / scale;
}

/** Map an item laid out at `scale` to the page: positions follow `map`, extents and type sizes grow by `scale`. */
export function zoomItem(item: DrawnItem, scale: number, map: { x: (v: number) => number; y: (v: number) => number }): DrawnItem {
  const at = { x: map.x(item.x), y: map.y(item.y) };
  switch (item.kind) {
    case 'text': return { ...item, ...at, size: item.size * scale };
    case 'ring': return { ...item, ...at, size: item.size * scale };
    case 'table': return { ...item, ...at, w: item.w * scale, columns: item.columns.map((c) => ({ ...c, width: c.width * scale })), scale };
    case 'chart': return { ...item, ...at, w: item.w * scale, h: item.h * scale, scale };
    default: return { ...item, ...at, w: item.w * scale, h: item.h * scale };
  }
}

/** Applies the block factor to the existing page cursor; page creation stays in composeDocument. */
export function scaledFrame(cursor: Omit<LayoutCursor, 'push'> & { push: (...items: DrawnItem[]) => void }, width: number, scale: number): LayoutCursor & { w: number; push: (...items: DrawnItem[]) => void } {
  return {
    get y() { return cursor.top + (cursor.y - cursor.top) / scale; },
    set y(value: number) { cursor.y = cursor.top + (value - cursor.top) * scale; },
    x: cursor.x, w: width / scale, top: cursor.top,
    bottom: cursor.top + (cursor.bottom - cursor.top) / scale,
    ensure: height => cursor.ensure(height * scale),
    newPage: cursor.newPage,
    push: (...items) => cursor.push(...(scale === 1 ? items : items.map(item => zoomItem(item, scale, {
      x: v => cursor.x + (v - cursor.x) * scale, y: v => cursor.top + (v - cursor.top) * scale,
    })))),
    truncate: cursor.truncate,
  };
}
