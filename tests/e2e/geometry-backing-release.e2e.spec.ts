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
  __ifc_lite_geometry_backing__?: (command: { action: string; points?: Array<[number, number]> }) => Promise<Array<Record<string, unknown>>>;
  __ifc_lite_cpu_geometry_held__?: () => Promise<{ totalBytes: number }>;
};

// Touch measurement after release has no hover in front of it: on-demand readback (#10264).
test.use({ hasTouch: true });
type TapStore = { measurePointLast: { x: number; y: number; z: number } | null;
  setActiveTool(tool: string): void; setMeasureMode(mode: string): void };
const FIXTURES = ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'tests/models/ara3d/duplex.ifc', 'tests/models/ara3d/C20-Institute-Var-2.ifc'];
const HOOK = '/src/lib/geometry-backing/backing-debug-hook.ts';
const DECODER = `/@fs${join(process.cwd(), 'packages/geometry/src/packed-instanced-decoder.ts')}`;
/** One instanced occurrence, as a comparable key: its entity and its transform (4 decimals). */
const OCCURRENCE_KEY = '(instance) => `${instance.entityId}:${Array.from(instance.transform, (v) => v.toFixed(4)).join(",")}`';

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
  await page.evaluate(async ([hookPath, decoderPath, keySource]) => {
    const { geometryBackingCommand } = await import(hookPath) as Hook;
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: Parameters<Hook['geometryBackingCommand']>[0] }).__ifc_lite_viewer_store__;
    // Small chunks: many per model, so readback leases a neighbourhood, not the whole model.
    await geometryBackingCommand(store, undefined, { action: 'start', options: { chunkBytes: 64 * 1024, queueBytes: 4 << 20 } });
    // Independent of the backing: every occurrence the loader enqueued, decoded from the wire bytes.
    const { decodeInstancedShard } = await import(decoderPath) as typeof import('../../packages/geometry/src/packed-instanced-decoder');
    const key = (0, eval)(keySource) as (instance: { entityId: number; transform: ArrayLike<number> }) => string;
    const expected: string[] = [];
    (globalThis as unknown as { __expected_occurrences__: string[] }).__expected_occurrences__ = expected;
    (globalThis as unknown as { __ifc_lite_instanced_shards__: { subscribe(l: (e: { kind: string; shards?: Array<{ bytes: ArrayBuffer }> }) => void): void } })
      .__ifc_lite_instanced_shards__.subscribe((event) => {
        if (event.kind !== 'enqueued') return;
        for (const shard of event.shards ?? []) for (const instance of decodeInstancedShard(new Uint8Array(shard.bytes.slice(0))).instances) expected.push(key(instance));
      });
  }, [HOOK, DECODER, OCCURRENCE_KEY] as const);
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
    // Phase 1, resident: seal, digest, and a dense magnetic-snap probe grid.
    const phase1 = await page.evaluate(async ([digest]) => {
      const g = globalThis as Probe;
      const hash = (0, eval)(digest) as (meshes: MeshData[]) => string;
      const [modelId, model] = [...g.__ifc_lite_viewer_store__!.getState().models][0];
      const before = hash(model.geometryResult!.meshes);
      const sealed = await g.__ifc_lite_geometry_backing__!({ action: 'seal' });
      const canvas = document.querySelector('canvas')!.getBoundingClientRect();
      const points: Array<[number, number]> = [];
      for (let i = 1; i <= 24; i++) for (let j = 1; j <= 16; j++) points.push([canvas.width * i / 25, canvas.height * j / 17]);
      const snapsBefore = await g.__ifc_lite_geometry_backing__!({ action: 'snap-probe-for-test', points });
      return { modelId, before, sealed, points, snapsBefore };
    }, [digestSource()] as const);
    type SnapRow = { outcome: string; instanced: boolean; expressId: number | null; point: number[] | null; snap: { type: string; position: number[] } | null };
    const before = phase1.snapsBefore as SnapRow[];
    // A real touchscreen tap in Measure > Point mode, at a point that hit geometry.
    const target = before.findIndex((probe) => probe.expressId !== null);
    expect(target, 'the probe grid must land on geometry').toBeGreaterThanOrEqual(0);
    const box = (await page.locator('canvas').first().boundingBox())!;
    const [tx, ty] = phase1.points[target];
    const tapAndRead = async (): Promise<number[]> => {
      const prior = await page.evaluate(() => {
        const state = (globalThis as Probe).__ifc_lite_viewer_store__!.getState() as unknown as TapStore;
        state.setActiveTool('measure'); state.setMeasureMode('point');
        return JSON.stringify(state.measurePointLast);
      });
      await page.touchscreen.tap(box.x + tx, box.y + ty);
      await page.waitForFunction((p) => JSON.stringify(((globalThis as Probe).__ifc_lite_viewer_store__!.getState() as unknown as TapStore)
        .measurePointLast) !== p, prior, { timeout: 30_000 });
      return page.evaluate(() => {
        const last = ((globalThis as Probe).__ifc_lite_viewer_store__!.getState() as unknown as TapStore).measurePointLast!;
        return [last.x, last.y, last.z];
      });
    };
    const tapResident = await tapAndRead();
    // Phase 2: test-only release, readback probes, and a full read-back digest.
    const report = await page.evaluate(async ([hookPath, digest, modelId, points, keySource]) => {
      const g = globalThis as Probe & typeof globalThis;
      const hash = (0, eval)(digest) as (meshes: MeshData[]) => string;
      const key = (0, eval)(keySource) as (instance: { entityId: number; transform: ArrayLike<number> }) => string;
      const { activeGeometryBackingTap } = await import(hookPath) as Hook;
      const model = g.__ifc_lite_viewer_store__!.getState().models.get(modelId)!;
      const heldBefore = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      const released = await g.__ifc_lite_geometry_backing__!({ action: 'release-for-test' });
      const heldAfter = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      const snapsAfter = await g.__ifc_lite_geometry_backing__!({ action: 'snap-probe-for-test', points });
      const storeEmpty = model.geometryResult!.meshes.every((mesh) => mesh.positions.length === 0);
      const backing = activeGeometryBackingTap()!.backing(modelId)!;
      const read: MeshData[] = [];
      let peak = 0;
      for await (const batch of backing.reader.meshes()) { read.push(...batch); peak = Math.max(peak, backing.reader.retainedBytes); }
      let occurrences = 0, templates = 0;
      const backed: string[] = [];
      for await (const shard of backing.reader.instancedShards()) {
        occurrences += shard.instances.length; templates += shard.templates.length;
        for (const instance of shard.instances) backed.push(key(instance));
      }
      const expected = [...(globalThis as unknown as { __expected_occurrences__: string[] }).__expected_occurrences__].sort();
      return { after: hash(read), released, heldBefore, heldAfter, storeEmpty, snapsAfter, occurrences, templates, peakDecodedBytes: peak,
        expectedOccurrences: expected.length, occurrencesMatch: JSON.stringify(backed.sort()) === JSON.stringify(expected) };
    }, [HOOK, digestSource(), phase1.modelId, phase1.points, OCCURRENCE_KEY] as const);
    // The probes fed readback at the last grid point; the tap point is uncovered, so the tap reads back on demand.
    const tapReleased = await tapAndRead();
    await page.screenshot({ path: info.outputPath('after-release.png') });
    const after = report.snapsAfter as SnapRow[];
    const summary = { ...phase1, ...report, snapsBefore: undefined, snapsAfter: undefined, points: undefined,
      hits: before.filter((probe) => probe.expressId !== null).length,
      instancedHits: before.filter((probe) => probe.instanced).length, fed: after.filter((probe) => probe.outcome === 'fed').length,
      tap: { at: [tx, ty], resident: tapResident, released: tapReleased } };
    await writeFile(info.outputPath('release-report.json'), JSON.stringify(summary, null, 2));
    await writeFile(info.outputPath('snap-probes.json'), JSON.stringify({ before, after }));
    expect(phase1.sealed[0].complete).toBe(true);
    expect(report.storeEmpty).toBe(true);
    expect(report.after).toBe(phase1.before);
    // Instanced readback, against the occurrences the loader enqueued (entity and transform, with multiplicity).
    expect(report.occurrencesMatch, `backed ${report.occurrences} vs enqueued ${report.expectedOccurrences} occurrences`).toBe(true);
    if (fixture.includes('C20-Institute')) expect(report.expectedOccurrences, 'C20-Institute is an instanced fixture').toBeGreaterThan(0);
    expect(report.heldAfter).toBeLessThan(report.heldBefore);
    for (let k = 0; k < 3; k++) expect(Math.abs(tapReleased[k] - tapResident[k]), 'touch point after release').toBeLessThan(1e-6);
    if (report.occurrences > 0) expect(summary.instancedHits, 'instanced occurrences under the grid').toBeGreaterThan(0);
    // Two missing snaps compare equal: require real snap targets, so the comparison proves the readback snaps.
    expect(before.filter((probe) => probe.snap !== null).length, 'the probe grid must produce snap targets').toBeGreaterThan(0);
    expect(before.every((probe) => probe.outcome === 'resident')).toBe(true);
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = after[i];
      expect(b.expressId, `probe ${i} entity (${JSON.stringify({ a, b })})`).toBe(a.expressId);
      if (a.expressId === null) continue;
      expect(b.outcome, `probe ${i} came from readback`).toBe('fed');
      for (let k = 0; k < 3; k++) expect(Math.abs(b.point![k] - a.point![k]), `probe ${i} hit`).toBeLessThan(1e-6);
      expect(b.snap === null, `probe ${i} snaps after release exactly when it snapped before`).toBe(a.snap === null);
      expect(b.snap?.type, `probe ${i} snap kind`).toBe(a.snap?.type);
      if (a.snap) for (let k = 0; k < 3; k++) expect(Math.abs(b.snap!.position[k] - a.snap.position[k]), `probe ${i} snap`).toBeLessThan(1e-6);
    }
    await page.evaluate(() => (globalThis as Probe).__ifc_lite_geometry_backing__!({ action: 'stop' }));
  });
}
