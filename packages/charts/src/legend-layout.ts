/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { format } from 'echarts/core';

/** Pack a static legend with the renderer's font metrics; measure the same truncated text it draws. */
export function packLegend(labels: readonly string[], width: number, font: string, scale = 1, symbolWidth = 10, symbolHeight = 10, itemGap = 6, heightBudget?: number) {
  const itemWidth = symbolWidth * scale;
  const itemHeight = symbolHeight * scale;
  const gap = itemGap * scale;
  // ECharts keeps this icon-to-text gap at 5px, independently of font size.
  const textGap = 5;
  const maxTextWidth = Math.max(0, width - itemWidth - textGap - gap);
  const formatter = (name: string) => format.truncateText(name, maxTextWidth, font, '…');
  const rowHeight = Math.max(itemHeight, format.getTextRect('M', font).height);
  const maxRows = heightBudget === undefined ? 4 : Math.max(1, Math.min(4, Math.floor((heightBudget + gap) / (rowHeight + gap))));
  let rows = labels.length > 0 ? 1 : 0;
  let rowWidth = 0;
  let shownItems = 0;
  for (const label of labels) {
    const textWidth = itemWidth + textGap + format.getTextRect(formatter(label), font).width;
    const nextWidth = rowWidth === 0 ? textWidth : rowWidth + gap + textWidth;
    if (nextWidth > width && rowWidth > 0) { rows += 1; rowWidth = 0; }
    // Extra categories still render; only their legend entries are capped (#4940).
    if (rows > maxRows) {
      // Preserve the established default pie layout, while resized legends
      // reserve only rendered rows within their share of the chart's height.
      if (heightBudget !== undefined) rows = maxRows;
      break;
    }
    rowWidth = rowWidth === 0 ? textWidth : nextWidth;
    shownItems += 1;
  }
  return { shownItems, rows, legendH: rows > 0 ? rows * rowHeight + (rows - 1) * gap : 0,
    formatter, itemWidth, itemHeight, itemGap: gap };
}
