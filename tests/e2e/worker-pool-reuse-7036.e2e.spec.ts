/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolReuseReport } from './worker-pool-reuse-7036.wasm.js';
import { assertHiddenBootAdmission, assertPoolReuseReport } from './worker-pool-reuse-7036.assertions.js';
import { startViewerDevServer } from './viewer-dev-server.js';

const root = new URL('../../', import.meta.url);
const fixtures = ['ara3d/AC20-FZK-Haus.ifc', 'various/01_Snowdon_Towers_Sample_Structural(1).ifc'];
const paths = fixtures.map(path => fileURLToPath(new URL(`tests/models/${path}`, root)));
const sourcePaths = [
  'packages/geometry/src/geometry-worker-pool.ts', 'packages/geometry/src/worker-pool-reset.ts',
  'packages/geometry/src/worker-heap.ts', 'packages/geometry/src/geometry.worker.ts',
  'packages/geometry/src/geometry-parallel.ts', 'packages/geometry/src/geometry-worker-init.ts',
  'packages/geometry/src/warm-pool.ts', 'packages/geometry/src/wasm-shared-module.ts',
  'packages/parser/src/worker-parser.ts', 'packages/parser/src/parser.worker.ts',
  'packages/parser/src/parser-worker-engine-module.ts', 'packages/load-trace/src/worker.ts',
  'packages/load-trace/src/counters.ts', 'apps/viewer/src/lib/wasm-prewarm.ts',
  'tests/e2e/worker-pool-reuse-7036.wasm.ts', 'tests/e2e/worker-pool-reuse-7036.e2e.spec.ts',
  'tests/e2e/worker-pool-reuse-7036.assertions.ts',
  'tests/e2e/worker-pool-reuse-7036.entry.html',
];


test('#7036 real WASM restores source, settings and federation IDs across reset worker epochs', async ({ page }, info) => {
  test.skip(paths.some(path => !existsSync(path)), 'Authoring-tool fixtures absent — run pnpm fixtures');
  const manifest: { files: Array<{ path: string; sha256: string }> } = JSON.parse(readFileSync(new URL('tests/models/manifest.json', root), 'utf8'));
  const hashes = paths.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
  for (let i = 0; i < fixtures.length; i++) expect(hashes[i]).toBe(manifest.files.find(file => file.path === fixtures[i])?.sha256);
  const server = await startViewerDevServer('worker-pool-reuse-7036');
  try {
    await page.goto(new URL(`/@fs/${fileURLToPath(new URL('./worker-pool-reuse-7036.entry.html', import.meta.url))}`, server.url).href);
    const report: PoolReuseReport = await page.evaluate(async ({ moduleUrl, sourceUrls }) => {
      const module: { runPoolReuseWitness(urls: [string, string]): Promise<PoolReuseReport> } = await import(moduleUrl);
      return module.runPoolReuseWitness(sourceUrls);
    }, { moduleUrl: `/@fs/${fileURLToPath(new URL('./worker-pool-reuse-7036.wasm.ts', import.meta.url))}`,
      sourceUrls: paths.map(path => `/@fs/${path}`) as [string, string] });
    await info.attach('real-wasm-worker-pool-epochs', { body: JSON.stringify({ fixtureHashes: hashes,
      sourceSha256: Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')])),
      browser: await page.evaluate(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated })),
      wasmSha256: createHash('sha256').update(readFileSync(new URL('packages/wasm/pkg/ifc-lite_bg.wasm', root))).digest('hex'), report }, null, 2), contentType: 'application/json' });
    assertPoolReuseReport(report);
    // #7036: refusal controls alter genuine report copies, never Worker execution.
    const controls: Array<(copy: PoolReuseReport) => void> = [
      copy => { copy.outputs.first.meshes = 0; },
      copy => { copy.outputs.repeat.digest += '-changed'; },
      copy => { copy.outputs.repeat.ids.push(-1); },
      copy => { copy.outputs.repeat.coordinates += '-changed'; },
      copy => { copy.outputs.repeat.triangles++; },
      copy => { Object.assign(copy.outputs.repeat, { unexpectedField: 1 }); },
      copy => { copy.spawnedAfterRepeat++; },
      copy => { copy.outputs.federatedFresh.digest += '-changed'; },
      copy => { copy.outputs.federated.geometryHashes = copy.outputs.federatedFresh.geometryHashes = 0; },
      copy => { copy.outputs.restoredFresh.digest += '-changed'; },
      copy => { copy.outputs.restored.geometryHashes = copy.outputs.restoredFresh.geometryHashes = 1; },
      copy => { copy.outputs.restored.digest = copy.outputs.restoredFresh.digest = 'changed'; },
      copy => { copy.outputs.federated.digest = copy.outputs.federatedFresh.digest = copy.outputs.first.digest; },
      copy => { copy.bootWorkerCreations++; },
      copy => { copy.bootAdmittedWorkers++; },
      copy => { copy.bootWarmingWorkers++; },
      copy => { copy.initialWorkerHeapBytes.pop(); },
      copy => { copy.initialWorkerHeapBytes[0] = 0; },
      copy => { copy.initialWorkerHeapBytes[0] = 9 * 1024 * 1024 + 1; },
      copy => { copy.parserHandoffDigest += '-changed'; },
      copy => { copy.finalIdleBytes = 144 * 1024 * 1024 + 1; },
      copy => { copy.federationIdsDistinct = false; },
    ];
    for (const mutate of controls) {
      const copy = structuredClone(report);
      mutate(copy);
      expect(() => assertPoolReuseReport(copy)).toThrow('#7036 Worker witness invariant failed:');
    }
    // Agreement with the original matcher on the complete plain report domain.
    const equalCopies = [
      Object.fromEntries(Object.entries(report.outputs.first).reverse()),
      { ...report.outputs.first, omitted: undefined },
    ];
    for (const output of equalCopies) {
      expect(output).toEqual(report.outputs.first);
      const copy = structuredClone(report);
      Reflect.set(copy.outputs, 'repeat', output);
      expect(() => assertPoolReuseReport(copy)).not.toThrow();
    }
    const arrayCases = [
      { left: [1, , 3], right: [1, undefined, 3], equal: true },
      { left: [1], right: [1, undefined], equal: true },
      { left: [0], right: [-0], equal: false },
      { left: [1, 2], right: [2, 1], equal: false },
    ];
    for (const { left, right, equal } of arrayCases) {
      if (equal) expect(right).toEqual(left);
      else expect(right).not.toEqual(left);
      const copy = structuredClone(report);
      // Undefined/sparse slots are deliberate matcher-domain controls, not IFC IDs.
      Reflect.set(copy.outputs.first, 'ids', left);
      Reflect.set(copy.outputs.repeat, 'ids', right);
      if (equal) expect(() => assertPoolReuseReport(copy)).not.toThrow();
      else expect(() => assertPoolReuseReport(copy)).toThrow('repeat equals first');
    }
    assertPoolReuseReport(report);
  } finally { await server.close(); }
});

test('#7036 idle boot does not create instances in an already hidden document', async ({ page }) => {
  const server = await startViewerDevServer('worker-pool-hidden-7036');
  try {
    await page.goto(new URL(`/@fs/${fileURLToPath(new URL('./worker-pool-reuse-7036.entry.html', import.meta.url))}`, server.url).href);
    const stats = await page.evaluate(async moduleUrl => {
      const module: { runHiddenBootAdmissionWitness(): Promise<{ idle: number; spawned: number }> } = await import(moduleUrl);
      return module.runHiddenBootAdmissionWitness();
    }, `/@fs/${fileURLToPath(new URL('./worker-pool-reuse-7036.wasm.ts', import.meta.url))}`);
    assertHiddenBootAdmission(stats);
    expect(() => assertHiddenBootAdmission({ ...stats, idle: 1 })).toThrow('hidden idle = 0');
    expect(() => assertHiddenBootAdmission({ ...stats, spawned: 1 })).toThrow('hidden spawned = 0');
    assertHiddenBootAdmission(stats);
  } finally { await server.close(); }
});
