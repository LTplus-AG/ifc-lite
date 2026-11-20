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
    const report = await page.evaluate(async ([hookPath, digest, keySource]) => {
      const g = globalThis as Probe;
      const hash = (0, eval)(digest) as (meshes: MeshData[]) => string;
      const key = (0, eval)(keySource) as (instance: { entityId: number; transform: ArrayLike<number> }) => string;
      const { activeGeometryBackingTap } = await import(hookPath) as Hook;
      const [modelId, model] = [...g.__ifc_lite_viewer_store__!.getState().models][0];
      const before = hash(model.geometryResult!.meshes);
      const sealed = await g.__ifc_lite_geometry_backing__!({ action: 'seal' });
      // Measurement/snap probes over a grid of the canvas: resident now, readback after release.
      const canvas = document.querySelector('canvas')!.getBoundingClientRect();
      const points: Array<[number, number]> = [];
      for (let i = 1; i <= 5; i++) for (let j = 1; j <= 4; j++) points.push([canvas.width * i / 6, canvas.height * j / 5]);
      const snapsBefore = await g.__ifc_lite_geometry_backing__!({ action: 'snap-probe-for-test', points });
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
      const instancedEntities = new Set<number>();
      for await (const shard of backing.reader.instancedShards()) {
        occurrences += shard.instances.length; templates += shard.templates.length;
        for (const instance of shard.instances) { backed.push(key(instance)); instancedEntities.add(instance.entityId); }
      }
      const expected = [...(globalThis as unknown as { __expected_occurrences__: string[] }).__expected_occurrences__].sort();
      return { modelId, before, after: hash(read), sealed, released, heldBefore, heldAfter, storeEmpty, snapsBefore, snapsAfter, instancedEntities: [...instancedEntities],
        occurrences, templates, peakDecodedBytes: peak, expectedOccurrences: expected.length,
        occurrencesMatch: JSON.stringify(backed.sort()) === JSON.stringify(expected) };
    }, [HOOK, digestSource(), OCCURRENCE_KEY] as const);
    await page.screenshot({ path: info.outputPath('after-release.png') });
    await writeFile(info.outputPath('release-report.json'), JSON.stringify(report, null, 2));
    expect(report.sealed[0].complete).toBe(true);
    expect(report.storeEmpty).toBe(true);
    expect(report.after).toBe(report.before);
    // Instanced readback, against the occurrences the loader enqueued (entity and transform, with multiplicity).
    expect(report.occurrencesMatch, `backed ${report.occurrences} vs enqueued ${report.expectedOccurrences} occurrences`).toBe(true);
    if (fixture.includes('C20-Institute')) expect(report.expectedOccurrences, 'C20-Institute is an instanced fixture').toBeGreaterThan(0);
    expect(report.heldAfter).toBeLessThan(report.heldBefore);
    // Measurement and snapping keep working after release, from readback alone.
    type Probe = { outcome: string; expressId: number | null; point: number[] | null; snap: { type: string; position: number[] } | null };
    const before = report.snapsBefore as Probe[], after = report.snapsAfter as Probe[];
    const hits = before.filter((probe) => probe.expressId !== null).length;
    expect(hits, 'the probe grid must land on geometry').toBeGreaterThan(0);
    // Two missing snaps compare equal: require real snap targets, so the comparison proves the readback snaps.
    expect(before.filter((probe) => probe.snap !== null).length, 'the probe grid must produce snap targets').toBeGreaterThan(0);
    expect(before.every((probe) => probe.outcome === 'resident')).toBe(true);
    // A probe on an entity with backed instanced occurrences refuses cleanly (no hit, no snap): measuring the
    // flat piece behind an occurrence is the wrong answer (#10880). Every other probe matches exactly, from readback.
    const instanced = new Set(report.instancedEntities as number[]);
    let fed = 0;
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = after[i];
      const detail = `probe ${i} (${JSON.stringify({ a, b })})`;
      if (a.expressId !== null && instanced.has(a.expressId)) {
        expect(b.outcome, `${detail} refuses an instanced front`).toBe('unavailable');
        expect(b.expressId === null && b.snap === null, `${detail} answers nothing`).toBe(true);
        continue;
      }
      expect(b.expressId, `${detail} entity`).toBe(a.expressId);
      if (a.expressId === null) continue;
      expect(b.outcome, `probe ${i} came from readback`).toBe('fed');
      fed++;
      for (let k = 0; k < 3; k++) expect(Math.abs(b.point![k] - a.point![k]), `probe ${i} hit`).toBeLessThan(1e-6);
      expect(b.snap === null, `probe ${i} snaps after release exactly when it snapped before`).toBe(a.snap === null);
      expect(b.snap?.type, `probe ${i} snap kind`).toBe(a.snap?.type);
      if (a.snap) for (let k = 0; k < 3; k++) expect(Math.abs(b.snap!.position[k] - a.snap.position[k]), `probe ${i} snap`).toBeLessThan(1e-6);
    }
    expect(fed, 'some probes are answered from readback, not all refused').toBeGreaterThan(0);
    await page.evaluate(() => (globalThis as Probe).__ifc_lite_geometry_backing__!({ action: 'stop' }));
  });
}
