/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A mixed federation's current-view export (#10264): model A is backed and
 * released FOR THE TEST ONLY, then model B is loaded and stays resident with
 * no backing. The real current-view collector (`readViewPdfSource`, the PDF
 * view export's source) must give exactly what it gives when neither is
 * released. Product release stays disabled.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

type MeshData = import('@ifc-lite/geometry').MeshData;
type Hook = typeof import('../../apps/viewer/src/lib/geometry-backing/backing-debug-hook');
type Probe = typeof globalThis & {
  __ifc_lite_viewer_store__?: { getState(): { loading: boolean; geometryStreamingActive: boolean; models: Map<string, unknown> } };
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_geometry_backing__?: (command: { action: string; pose?: unknown }) => Promise<Array<Record<string, unknown>>>;
  __ifc_lite_pick_parity__?: (request: { columns: number; rows: number }) => Promise<{ rows: Array<{ annotation: boolean; gpu: { expressId: number } | null }> }>;
  __ifc_lite_cpu_geometry_held__?: () => Promise<{ totalBytes: number }>;
};
const HOOK = '/src/lib/geometry-backing/backing-debug-hook.ts';
// A carries real instancing; B is flat and arrives after A's release.
const A = 'tests/models/ara3d/C20-Institute-Var-2.ifc';
const B = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

let server: ViewerDevServer;
test.skip(process.env.GEOMETRY_BACKING_GPU !== '1', 'Set GEOMETRY_BACKING_GPU=1 on a real WebGPU adapter; SwiftShader is not release evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('geometry-backing-mixed-export'); });
test.afterAll(async () => { await server?.close(); });
test.describe.configure({ timeout: 900_000 });

async function load(page: Page, file: string, count: number): Promise<void> {
  await page.locator('input[type=file]').nth(count === 1 ? 0 : 1).setInputFiles(join(process.cwd(), file));
  await page.waitForFunction((n) => {
    const g = globalThis as Probe, s = g.__ifc_lite_viewer_store__!.getState();
    return !s.loading && !s.geometryStreamingActive && s.models.size === n && g.__ifc_lite_scene_settled__?.()
      && Boolean(g.__ifc_lite_geometry_backing__);
  }, count, { timeout: 480_000, polling: 250 });
}

/** The current-view export source, through the export entry point's readback context. */
async function viewExport(page: Page): Promise<{ meshes: number; instanced: number; digest: string[] }> {
  return page.evaluate(async () => {
    const [{ withReleasedExportGeometry }, { readViewPdfSource }, { useViewerStore }] = await Promise.all([
      import('/src/utils/instancedExport.ts'), import('/src/lib/export/view-pdf/view-pdf-export-source.ts'), import('/src/store/index.ts'),
    ]) as [typeof import('../../apps/viewer/src/utils/instancedExport'),
      typeof import('../../apps/viewer/src/lib/export/view-pdf/view-pdf-export-source'), typeof import('../../apps/viewer/src/store')];
    const source = await withReleasedExportGeometry(() => readViewPdfSource(useViewerStore.getState()));
    const meshes = source.view.meshes as MeshData[];
    const hash = (mesh: MeshData) => {
      let h = 0x811c9dc5;
      const mix = (byte: number) => { h = Math.imul(h ^ byte, 0x01000193) >>> 0; };
      const { positions, normals, indices, occurrenceKey: _key, ...scalars } = mesh as MeshData & { occurrenceKey?: string };
      // Canonical: key order is not part of a mesh (a read-back copy re-adds its record fields last).
      const canonical = (v: unknown): unknown => (ArrayBuffer.isView(v) ? undefined : typeof v === 'bigint' ? `n${v}`
        : Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v);
      const text = JSON.stringify(canonical(scalars));
      const fence = mesh.appearanceSource;
      for (const view of [fence?.indices, fence?.sourceIndices, fence?.cornerIndices]) {
        if (!view) { mix(0); continue; }
        const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (let i = 0; i < u8.length; i++) mix(u8[i]);
      }
      mix(fence ? (fence.indices === indices ? 1 : 2) : 3);
      for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i) & 0xff);
      for (const view of [positions, normals, indices]) {
        const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (let i = 0; i < u8.length; i++) mix(u8[i]);
      }
      const inst = (mesh as { occurrenceKey?: string }).occurrenceKey?.includes(':inst:') ? 'I' : 'F';
      return `${mesh.expressId}:${mesh.modelIndex ?? 0}:${inst}:${mesh.appearanceSource ? 'A' : '-'}:${h.toString(16)}`;
    };
    return { meshes: meshes.length, instanced: meshes.filter((m) => (m as { occurrenceKey?: string }).occurrenceKey?.includes(':inst:')).length,
      digest: meshes.map(hash).sort() };
  });
}

async function open(page: Page, tap: boolean): Promise<void> {
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean((globalThis as Probe).__ifc_lite_viewer_store__), null, { timeout: 180_000 });
  if (!tap) return;
  await page.evaluate(async (hookPath) => {
    const { geometryBackingCommand } = await import(hookPath) as Hook;
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: Parameters<Hook['geometryBackingCommand']>[0] }).__ifc_lite_viewer_store__;
    await geometryBackingCommand(store, undefined, { action: 'start', options: { chunkBytes: 64 * 1024, queueBytes: 4 << 20 } });
  }, HOOK);
}

test('current-view export of a released model plus a later resident model matches the resident export', async ({ page }, info) => {
  test.skip(![A, B].every((f) => existsSync(join(process.cwd(), f))), 'fixtures missing; run `pnpm fixtures`');
  // Warm the cache first, so the reference and the mixed session load A the same way.
  await open(page, true);
  await load(page, A, 1);
  await page.waitForTimeout(5000); // the cache write runs in the background after the scene settles
  // Resident reference: both models, nothing released.
  await open(page, true);
  await load(page, A, 1);
  await load(page, B, 2);
  const resident = await viewExport(page);
  // Mixed: A backed and released, THEN B loaded resident with no backing of its own required.
  await open(page, true);
  await load(page, A, 1);
  const released = await page.evaluate(async () => {
    const g = globalThis as Probe;
    const [status] = await g.__ifc_lite_geometry_backing__!({ action: 'seal' });
    const held = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
    if (status.complete !== true) throw new Error(`A is not sealed complete: ${JSON.stringify(status, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}`);
    const rows = await g.__ifc_lite_geometry_backing__!({ action: 'release-for-test' });
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    return { status: plain(status), rows: plain(rows), heldBefore: held, heldAfter: (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes };
  });
  expect(released.heldAfter, JSON.stringify(released)).toBeLessThan(released.heldBefore);
  // A was hydrated from its warm scene snapshot (no streamed route pass): a real device loss now must
  // rebuild exactly what that snapshot drew, from the backing.
  const recovery = await page.evaluate(async () => {
    const g = globalThis as Probe;
    const hook = g.__ifc_lite_geometry_backing__!;
    const grid = async () => (await g.__ifc_lite_pick_parity__!({ columns: 48, rows: 32 })).rows
      .map((row) => (row.annotation ? null : row.gpu?.expressId ?? null));
    const [pose] = await hook({ action: 'camera-for-test' });
    const before = await grid();
    await hook({ action: 'lose-device-for-test' });
    let state = { lost: true, ready: false };
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = (await hook({ action: 'device-state-for-test' }))[0] as typeof state;
      if (!state.lost && state.ready) break;
    }
    await hook({ action: 'camera-for-test', pose });
    for (let i = 0; i < 200 && !(g.__ifc_lite_scene_settled__?.()); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = await grid();
    return { state, drawn: before.filter((id) => id !== null).length, drawnAfter: after.filter((id) => id !== null).length,
      differing: before.filter((id, i) => id !== after[i]).length };
  });
  await writeFile(info.outputPath('warm-recovery.json'), JSON.stringify(recovery, null, 2));
  expect(recovery.drawn, 'the hydrated, released scene draws entities').toBeGreaterThan(100);
  // A rebuild of an unrecorded list either fails closed (still lost) or draws nothing: both are wrong here.
  expect(recovery.state, JSON.stringify(recovery)).toEqual({ lost: false, ready: true });
  expect(recovery.differing, `GPU picks after recovering a snapshot-hydrated scene: ${JSON.stringify(recovery)}`).toBe(0);
  await load(page, B, 2);
  const mixed = await viewExport(page);
  await page.screenshot({ path: info.outputPath('mixed.png') });
  await writeFile(info.outputPath('mixed-export.json'), JSON.stringify({ resident: { meshes: resident.meshes, instanced: resident.instanced },
    mixed: { meshes: mixed.meshes, instanced: mixed.instanced }, release: released }, null, 2));
  expect(resident.instanced, 'A carries real instancing').toBeGreaterThan(0);
  expect(mixed.meshes).toBe(resident.meshes);
  expect(mixed.instanced).toBe(resident.instanced);
  const differing = mixed.digest.filter((d, i) => d !== resident.digest[i]);
  const tally = (list: string[]) => { const t: Record<string, number> = {}; for (const d of list) { const k = d.split(':').slice(1, 4).join(':'); t[k] = (t[k] ?? 0) + 1; } return t; };
  const residentSet = new Set(resident.digest);
  await writeFile(info.outputPath('first-diffs.json'), JSON.stringify({ resident: tally(resident.digest), mixed: tally(mixed.digest),
    mixedNotInResident: tally(mixed.digest.filter((d) => !residentSet.has(d))) }, null, 2));
  expect(differing.slice(0, 5), `${differing.length} of ${mixed.meshes} exported meshes differ`).toEqual([]);
});
