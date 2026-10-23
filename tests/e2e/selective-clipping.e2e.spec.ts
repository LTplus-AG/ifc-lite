/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { SelectiveClippingReport } from './selective-clipping.gpu.js';
import { DEVICE_LOST_SIGNAL, skipForGpuDeviceLoss, watchGpuDeviceLoss } from './gpu-device-loss.js';
import { startViewerDevServer } from './viewer-dev-server.js';

test('#8015 selective clipping agrees in colour, GPU picking and CPU raycasting', async ({ page }, info) => {
  const gpu = await watchGpuDeviceLoss(page);
  const server = await startViewerDevServer('selective-clipping');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const moduleUrl = `/@fs/${fileURLToPath(new URL('./selective-clipping.gpu.ts', import.meta.url))}`;
    const report = await gpu.requireLiveGpu('selective clipping', async () => {
      try {
        return await page.evaluate(async url => {
          const module: { runSelectiveClippingWitness(): Promise<SelectiveClippingReport> } = await import(url);
          return module.runSelectiveClippingWitness();
        }, moduleUrl);
      } catch (error) {
        if (DEVICE_LOST_SIGNAL.test(String(error))) skipForGpuDeviceLoss('selective clipping', String(error).slice(0, 300));
        throw error;
      }
    });
    if (report.screenshot) await info.attach('selective-clipping', { body: Buffer.from(report.screenshot.split(',')[1]!, 'base64'), contentType: 'image/png' });
    await info.attach('selective-clipping-report', { body: JSON.stringify({ ...report, screenshot: undefined }, null, 2), contentType: 'application/json' });
    expect(report.errors).toEqual([]);
    expect(report.gpuErrors).toBe(0);
    expect(report.rows).toHaveLength(36);
    for (const row of report.rows) {
      expect(row.checked).toBe(6);
      expect(row.mismatches, `${row.family}/${row.state}`).toEqual([]);
      expect(row.shadowMismatches, `shadow depth: ${row.family}/${row.state}`).toEqual([]);
    }
  } finally { await server.close(); }
});
