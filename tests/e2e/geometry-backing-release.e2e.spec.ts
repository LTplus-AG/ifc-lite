/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The canonical loader's output, backed through the test/debug-only tap, then
 * released FOR THE TEST ONLY: the CPU-held figure must fall, and every flat
 * mesh and every instanced occurrence must read back from real IndexedDB
 * exactly as it was. Product release stays disabled; this is reachable only
 * through `__ifc_lite_geometry_backing__`.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

type Hook = typeof import('../../apps/viewer/src/lib/geometry-backing/backing-debug-hook');
type MeshData = import('@ifc-lite/geometry').MeshData;
type Probe = typeof globalThis & {
  __ifc_lite_viewer_store__?: { getState(): { loading: boolean; geometryStreamingActive: boolean;
    models: Map<string, { geometryResult: { meshes: MeshData[] } | null }> } };
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_geometry_backing__?: (command: { action: string }) => Promise<Array<Record<string, unknown>>>;
  __ifc_lite_cpu_geometry_held__?: () => Promise<{ totalBytes: number }>;
};

const FIXTURES = ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'tests/models/ara3d/duplex.ifc', 'tests/models/ara3d/C20-Institute-Var-2.ifc'];
const HOOK = '/src/lib/geometry-backing/backing-debug-hook.ts';

let server: ViewerDevServer;
// The debug hooks exist once a renderer is ready: a real adapter, headed (see the config).
test.skip(process.env.GEOMETRY_BACKING_GPU !== '1', 'Set GEOMETRY_BACKING_GPU=1 on a real WebGPU adapter; SwiftShader is not release evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('geometry-backing-release'); });
test.afterAll(async () => { await server?.close(); });
test.describe.configure({ timeout: 600_000 });

/** Order-sensitive digest of every observable mesh field and identity relation. */
function digestSource(): string {
  return `(${(meshes: MeshData[]) => {
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    const mix = (byte: number) => { a = Math.imul(a ^ byte, 0x01000193) >>> 0; b = Math.imul(b ^ byte, 0x5bd1e995) >>> 0; };
    const text = (value: string) => { for (let i = 0; i < value.length; i++) mix(value.charCodeAt(i) & 0xff); };
    const bytes = (view: ArrayBufferView | undefined) => {
      if (!view) { text('none'); return; }
      text(view.constructor.name);
      const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let i = 0; i < u8.length; i++) mix(u8[i]);
    };
    for (const mesh of meshes) {
      const { positions, normals, indices, entityIds, uvs, appearanceSource, texture, textureBitmap, ...scalars } = mesh;
      text(JSON.stringify(scalars, (_k, v) => typeof v === 'bigint' ? `n${v}` : v));
      for (const view of [positions, normals, indices, entityIds, uvs, texture?.rgba]) bytes(view);
      text(texture ? JSON.stringify([texture.width, texture.height, texture.repeatS, texture.repeatT]) : '-');
      text(textureBitmap ? 'bitmap' : '-');
      if (appearanceSource) {
        text(appearanceSource.indices === indices ? 'fence=indices' : 'fence=own');
        bytes(appearanceSource.indices); bytes(appearanceSource.sourceIndices); bytes(appearanceSource.cornerIndices);
      }
    }
    return `${a.toString(16)}${b.toString(16)}:${meshes.length}`;
  }})`;
}

async function open(page: Page): Promise<void> {
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean((globalThis as Probe).__ifc_lite_viewer_store__), null, { timeout: 180_000 });
  // The viewport hook appears only once a renderer exists, after a load starts;
  // start the tap through the same module first so it sees the whole stream.
  await page.evaluate(async (hookPath) => {
    const { geometryBackingCommand } = await import(hookPath) as Hook;
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: Parameters<Hook['geometryBackingCommand']>[0] }).__ifc_lite_viewer_store__;
    await geometryBackingCommand(store, undefined, { action: 'start' });
  }, HOOK);
}

for (const fixture of FIXTURES) {
  test(`test-only release reads back ${fixture.split('/').pop()} exactly from real IndexedDB`, async ({ page }, info) => {
    test.skip(!existsSync(join(process.cwd(), fixture)), `${fixture} missing; run \`pnpm fixtures\``);
    await open(page);
    await page.locator('#file-input-open').setInputFiles(join(process.cwd(), fixture));
    await page.waitForFunction(() => {
      const g = globalThis as Probe, s = g.__ifc_lite_viewer_store__!.getState();
      return !s.loading && !s.geometryStreamingActive && s.models.size === 1 && g.__ifc_lite_scene_settled__?.()
        && Boolean(g.__ifc_lite_geometry_backing__);
    }, null, { timeout: 480_000, polling: 250 });
    await page.screenshot({ path: info.outputPath('before-release.png') });
    const report = await page.evaluate(async ([hookPath, digest]) => {
      const g = globalThis as Probe;
      const hash = (0, eval)(digest) as (meshes: MeshData[]) => string;
      const { activeGeometryBackingTap } = await import(hookPath) as Hook;
      const [modelId, model] = [...g.__ifc_lite_viewer_store__!.getState().models][0];
      const before = hash(model.geometryResult!.meshes);
      const sealed = await g.__ifc_lite_geometry_backing__!({ action: 'seal' });
      const heldBefore = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      const released = await g.__ifc_lite_geometry_backing__!({ action: 'release-for-test' });
      const heldAfter = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      const storeEmpty = model.geometryResult!.meshes.every((mesh) => mesh.positions.length === 0);
      const backing = activeGeometryBackingTap()!.backing(modelId)!;
      const read: MeshData[] = [];
      let peak = 0;
      for await (const batch of backing.reader.meshes()) { read.push(...batch); peak = Math.max(peak, backing.reader.retainedBytes); }
      let occurrences = 0, templates = 0;
      for await (const shard of backing.reader.instancedShards()) { occurrences += shard.instances.length; templates += shard.templates.length; }
      return { modelId, before, after: hash(read), sealed, released, heldBefore, heldAfter, storeEmpty,
        occurrences, templates, peakDecodedBytes: peak };
    }, [HOOK, digestSource()] as const);
    await page.screenshot({ path: info.outputPath('after-release.png') });
    await writeFile(info.outputPath('release-report.json'), JSON.stringify(report, null, 2));
    expect(report.sealed[0].complete).toBe(true);
    expect(report.storeEmpty).toBe(true);
    expect(report.after).toBe(report.before);
    expect(report.heldAfter).toBeLessThan(report.heldBefore);
    await page.evaluate(() => (globalThis as Probe).__ifc_lite_geometry_backing__!({ action: 'stop' }));
  });
}
