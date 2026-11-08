/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { EdgeLineReport, EdgeLineRow } from './edge-line-continuity.gpu.js';
import { startViewerDevServer } from './viewer-dev-server.js';

/** rgba8 rounding of the darken blend. */
const TOLERANCE = 1;

/**
 * A long straight edge drawn slanted used to come out dotted: the edge pass
 * averaged its tap votes, and the pixel at each step of the raster staircase
 * sees the other side of the edge in two directions, so it drew twice as dark
 * as the rest of the line. Every pixel along the edge must now be exactly as
 * dark as beside the same edge drawn axis-aligned, with no gap and no darker
 * dot, for every cue, quality, tap radius and MSAA count. A crease hidden
 * behind an occluder still draws nothing.
 */
test('edge-pass lines stay continuous along slanted straight edges (#9360)', async ({ page }, info) => {
  const server = await startViewerDevServer('edge-line-continuity');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const report: EdgeLineReport = await page.evaluate(async url => {
      const module: { runEdgeLineWitness(): Promise<EdgeLineReport> } = await import(url);
      return module.runEdgeLineWitness();
    }, `/@fs/${fileURLToPath(new URL('./edge-line-continuity.gpu.ts', import.meta.url))}`);
    await info.attach('edge-line-continuity-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(report.errors, 'real GPU validation and execution errors').toEqual([]);
    expect(report.rows).toHaveLength(64);

    const key = (row: EdgeLineRow) => `${row.edgeCase}/${row.samples}x/${row.quality}/r${row.radius}`;
    const axisAligned = new Map(report.rows.filter(row => !row.slanted).map(row => [key(row), row]));
    for (const row of report.rows) {
      const where = `${key(row)} ${row.slanted ? 'slanted' : 'axis-aligned'}`;
      if (row.edgeCase === 'hidden') {
        expect(row.frameMax, `${where}: a hidden crease draws no edge`).toBe(0);
        continue;
      }
      const level = axisAligned.get(key(row))?.columnMax[0] ?? 0;
      expect(level, `${where}: the axis-aligned edge draws a line`).toBeGreaterThan(0);
      const off = row.columnMax.flatMap((v, x) => (Math.abs(v - level) > TOLERANCE ? [`x+${x}: ${v}`] : []));
      expect(off, `${where}: every column of the edge at the line's level ${level}`).toEqual([]);
      expect(row.frameMax, `${where}: no pixel darker than the line`).toBeLessThanOrEqual(level + TOLERANCE);
    }
  } finally { await server.close(); }
});
