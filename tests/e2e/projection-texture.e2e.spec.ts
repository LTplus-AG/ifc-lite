/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startViewerDevServer } from './viewer-dev-server.js';
import type { runTextureDepthWitness } from './projection-texture.gpu.js';

test('orthographic geometric prepass preserves real texture cutouts and partial draws (#6729)', async ({ page }, info) => {
  const server = await startViewerDevServer('projection-texture');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const report = await page.evaluate(async url => {
      const module: { runTextureDepthWitness: typeof runTextureDepthWitness } = await import(url);
      return module.runTextureDepthWitness();
    }, `/@fs/${fileURLToPath(new URL('./projection-texture.gpu.ts', import.meta.url))}`);
    await info.attach('textured-depth-eligibility', { body: JSON.stringify(report), contentType: 'application/json' });
    expect(report.errors).toEqual([]); expect(report.rows).toHaveLength(2);
    for (const row of report.rows) {
      expect(row.cutoutOwner, JSON.stringify(row)).toBe(report.rearId);
      expect(row.opaqueOwner, JSON.stringify(row)).toBe(report.frontId);
    }
  } finally { await server.close(); }
});
