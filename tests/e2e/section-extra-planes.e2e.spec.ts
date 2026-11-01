/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { SectionPlanesReport } from './section-extra-planes.gpu.js';
import { DEVICE_LOST_SIGNAL, skipForGpuDeviceLoss, watchGpuDeviceLoss } from './gpu-device-loss.js';
import { startViewerDevServer } from './viewer-dev-server.js';

test('colour, GPU pick and CPU raycast agree through 0 -> 7 -> 2 -> 0 -> 7 cutting planes (#7545)', async ({ page }, info) => {
  const gpu = await watchGpuDeviceLoss(page);
  const server = await startViewerDevServer('section-extra-planes');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const moduleUrl = `/@fs/${fileURLToPath(new URL('./section-extra-planes.gpu.ts', import.meta.url))}`;
    // Hosted SwiftShader can drop Dawn's instance under a full Renderer; that is the environment, not the
    // clip. A strict run (a real GPU, the evidence that counts) never skips and fails with the loss annotated.
    const report: SectionPlanesReport = await gpu.requireLiveGpu('the section-planes witness', async () => {
      try {
        return await page.evaluate(async url => {
          const module: { runSectionExtraPlanesWitness(): Promise<SectionPlanesReport> } = await import(url);
          return module.runSectionExtraPlanesWitness();
        }, moduleUrl);
      } catch (error) {
        if (DEVICE_LOST_SIGNAL.test(String(error))) skipForGpuDeviceLoss('the section-planes witness', String(error).slice(0, 300));
        throw error;
      }
    });
    await info.attach('section-extra-planes-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(report.errors, 'real GPU validation errors').toEqual([]);
    expect(report.gpuErrors, 'renderer-observed GPU errors').toBe(0);
    // flat, instanced and point, each through six plane-set states on one renderer.
    expect(report.rows).toHaveLength(18);
    for (const row of report.rows) {
      const where = `${row.family}/${row.state}`;
      expect(row.mismatches, `colour, GPU pick and CPU raycast must equal the analytical keep/remove at ${where}`).toEqual([]);
      if (row.state.startsWith('none')) expect(row.removed, `nothing is clipped at ${where}`).toBe(0);
      else expect(row.removed, `something is clipped at ${where}`).toBeGreaterThan(0);
      expect(row.kept, `something survives at ${where}`).toBeGreaterThan(0);
    }
    // The ninth plane (an eighth extra) is beyond capacity: the result is the seven-plane one, not an emptied scene.
    for (const family of ['flat', 'instanced', 'point']) {
      const seven = report.rows.find(r => r.family === family && r.state === 'seven-extras')!;
      const beyond = report.rows.find(r => r.family === family && r.state === 'eight-extras-capacity')!;
      expect([beyond.kept, beyond.removed]).toEqual([seven.kept, seven.removed]);
    }
    // The CPU raycaster must actually be in the comparison for the families it supports.
    expect(report.rows.filter(r => r.family !== 'point').every(r => r.cpuSupported), 'CPU raycaster sees flat and instanced meshes').toBe(true);
  } finally { await server.close(); }
});
