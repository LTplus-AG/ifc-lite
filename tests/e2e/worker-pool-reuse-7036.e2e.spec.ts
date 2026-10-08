/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolReuseReport } from './worker-pool-reuse-7036.wasm.js';
import { startViewerDevServer } from './viewer-dev-server.js';

const root = new URL('../../', import.meta.url);
const fixtures = ['ara3d/AC20-FZK-Haus.ifc', 'various/01_Snowdon_Towers_Sample_Structural(1).ifc'];
const paths = fixtures.map(path => fileURLToPath(new URL(`tests/models/${path}`, root)));

test('#7036 real WASM restores source, settings and federation IDs across reset worker epochs', async ({ page }, info) => {
  test.skip(paths.some(path => !existsSync(path)), 'Authoring-tool fixtures absent — run pnpm fixtures');
  const manifest: { files: Array<{ path: string; sha256: string }> } = JSON.parse(readFileSync(new URL('tests/models/manifest.json', root), 'utf8'));
  const hashes = paths.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
  for (let i = 0; i < fixtures.length; i++) expect(hashes[i]).toBe(manifest.files.find(file => file.path === fixtures[i])?.sha256);
  const server = await startViewerDevServer('worker-pool-reuse-7036');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const report: PoolReuseReport = await page.evaluate(async ({ moduleUrl, sourceUrls }) => {
      const module: { runPoolReuseWitness(urls: [string, string]): Promise<PoolReuseReport> } = await import(moduleUrl);
      return module.runPoolReuseWitness(sourceUrls);
    }, { moduleUrl: `/@fs/${fileURLToPath(new URL('./worker-pool-reuse-7036.wasm.ts', import.meta.url))}`,
      sourceUrls: paths.map(path => `/@fs/${path}`) as [string, string] });
    await info.attach('real-wasm-worker-pool-epochs', { body: JSON.stringify({ fixtureHashes: hashes, wasmSha256: createHash('sha256').update(readFileSync(new URL('packages/wasm/pkg/ifc-lite_bg.wasm', root))).digest('hex'), report }, null, 2), contentType: 'application/json' });
    expect(report.outputs.first.meshes).toBeGreaterThan(0);
    expect(report.outputs.repeat).toEqual(report.outputs.first);
    expect(report.spawnedAfterRepeat).toBe(report.spawnedBeforeRepeat);
    expect(report.outputs.federated).toEqual(report.outputs.federatedFresh);
    expect(report.outputs.federated.geometryHashes).toBeGreaterThan(0);
    expect(report.outputs.restored).toEqual(report.outputs.restoredFresh);
    expect(report.outputs.restored.geometryHashes).toBe(0);
    expect(report.outputs.restored.digest).toBe(report.outputs.first.digest);
    expect(report.outputs.federated.digest).not.toBe(report.outputs.first.digest);
    expect(report.bootWorkerCreations).toBe(2);
    expect(report.bootAdmittedWorkers).toBe(2);
    expect(report.bootWarmingWorkers).toBe(0);
    expect(report.initialWorkerHeapBytes).toHaveLength(2);
    for (const heap of report.initialWorkerHeapBytes) {
      expect(heap).toBeGreaterThan(0); expect(heap).toBeLessThanOrEqual(9 * 1024 * 1024);
    }
    expect(report.parserHandoffDigest).toBe(report.parserScanDigest);
    expect(report.finalIdleBytes).toBeLessThanOrEqual(144 * 1024 * 1024);
    expect(report.federationIdsDistinct).toBe(true);
  } finally { await server.close(); }
});

test('#7036 idle boot does not create instances in an already hidden document', async ({ page }) => {
  const server = await startViewerDevServer('worker-pool-hidden-7036');
  try {
    await page.goto(new URL('/oauth/autodesk/callback', server.url).href);
    const stats = await page.evaluate(async moduleUrl => {
      const module: { runHiddenBootAdmissionWitness(): Promise<{ idle: number; spawned: number }> } = await import(moduleUrl);
      return module.runHiddenBootAdmissionWitness();
    }, `/@fs/${fileURLToPath(new URL('./worker-pool-reuse-7036.wasm.ts', import.meta.url))}`);
    expect(stats.idle).toBe(0); expect(stats.spawned).toBe(0);
  } finally { await server.close(); }
});
