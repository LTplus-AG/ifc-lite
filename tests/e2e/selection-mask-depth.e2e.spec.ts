/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { MaskDepthReport } from './selection-mask-depth.gpu.js';
import { startViewerDevServer } from './viewer-dev-server.js';

test('visible masks respect 1mm occluders at matching raster samples (#6729)', async ({ page }, info) => {
  const server = await startViewerDevServer('selection-mask-depth');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const moduleUrl = `/@fs/${fileURLToPath(new URL('./selection-mask-depth.gpu.ts', import.meta.url))}`;
    const report: MaskDepthReport = await page.evaluate(async url => {
      const module: { runMaskDepthWitness(): Promise<MaskDepthReport> } = await import(url);
      return module.runMaskDepthWitness();
    }, moduleUrl);
    await info.attach('production-mask-depth-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(report.errors, 'real GPU validation and execution errors').toEqual([]);
    expect(report.rows).toHaveLength(96);
    for (const row of report.rows) {
      const witness = JSON.stringify(row);
      const expected = row.case === 'occluded-1mm' ? 0 : 576;
      expect(row.selected, `selected visibility ${witness}`).toBe(expected);
      expect(row.hovered, `hover visibility ${witness}`).toBe(expected);
      expect(row.all, `deliberate occluded silhouette ${witness}`).toBe(576);
    }
  } finally { await server.close(); }
});
