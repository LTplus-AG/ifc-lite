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
  __ifc_lite_geometry_backing__?: (command: { action: string; points?: Array<[number, number]>; pose?: unknown }) => Promise<Array<Record<string, unknown>>>;
  __ifc_lite_cpu_geometry_held__?: () => Promise<{ totalBytes: number }>;
  __ifc_lite_pick_parity__?: (request: { columns: number; rows: number }) => Promise<{ rows: Array<{ annotation: boolean; gpu: { expressId: number } | null }> }>;
};

// Touch measurement after release has no hover in front of it: on-demand readback (#10264).
test.use({ hasTouch: true });
type TapStore = { measurePointLast: { x: number; y: number; z: number } | null;
  setActiveTool(tool: string): void; setMeasureMode(mode: string): void };
const FIXTURES = ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'tests/models/ara3d/duplex.ifc', 'tests/models/ara3d/C20-Institute-Var-2.ifc'];
const HOOK = '/src/lib/geometry-backing/backing-debug-hook.ts';
const DRAWING = `/@fs${join(process.cwd(), 'packages/drawing-2d/src/index.ts')}`;

/**
 * Tool outputs that must not change when CPU geometry is released (#10264):
 * the export collector (flat + instanced occurrences), a mid-height section cap
 * cut, one entity's centre bounds and the mesh-area map. Runs in the page; the
 * released run goes through the readback paths, the resident run does not.
 */
async function toolProbe(page: Page, modelId: string): Promise<Record<string, unknown>> {
  return page.evaluate(async ([drawingPath, id, digest]) => {
    const [exportMod, cut, area, metaMod, provenance, drawing] = await Promise.all([
      import('/src/utils/instancedExport.ts'), import('/src/lib/geometry-backing/cut-readback.ts'),
      import('/src/components/viewer/tools/measure-modes/mesh-area.ts'),
      import('/src/lib/geometry-backing/released-geometry-metadata.ts'), import('/src/lib/released-mesh-provenance.ts'),
      import(drawingPath),
    ]) as [typeof import('../../apps/viewer/src/utils/instancedExport'), typeof import('../../apps/viewer/src/lib/geometry-backing/cut-readback'),
      typeof import('../../apps/viewer/src/components/viewer/tools/measure-modes/mesh-area'),
      typeof import('../../apps/viewer/src/lib/geometry-backing/released-geometry-metadata'), typeof import('../../apps/viewer/src/lib/released-mesh-provenance'),
      typeof import('../../packages/drawing-2d/src/index')];
    const hash = (0, eval)(digest) as (meshes: MeshData[]) => string;
    const state = (globalThis as Probe).__ifc_lite_viewer_store__!.getState() as unknown as {
      models: Map<string, { idOffset: number; maxExpressId: number; geometryResult: { meshes: MeshData[]; coordinateInfo: { shiftedBounds: { min: { y: number }; max: { y: number } } } } }> };
    const model = state.models.get(id)!;
    const gr = model.geometryResult as unknown as Parameters<typeof exportMod.withInstancedMeshes>[0];
    const range = { modelId: id, idOffset: model.idOffset, maxExpressId: model.maxExpressId };
    const exported = await exportMod.withReleasedExportGeometry((context) => exportMod.withInstancedMeshes(gr, range, context));
    const unkeyed = exported.meshes.map((m) => ({ ...m, occurrenceKey: undefined }));
    // A mid-height cap cut, as useExtraSectionCaps runs it.
    const b = model.geometryResult.coordinateInfo.shiftedBounds;
    const config = drawing.createSectionConfig('y', (b.min.y + b.max.y) / 2, { projectionDepth: 0, includeHiddenLines: false });
    const generator = new drawing.Drawing2DGenerator();
    await generator.initialize();
    const capped = await cut.withCutGeometry(model.geometryResult.meshes, config.plane, 0, (meshes) => generator.generate(meshes as MeshData[], config,
      { includeHiddenLines: false, includeProjection: false, includeEdges: false, mergeLines: true }));
    // A plan cut, as usePlanCut runs it: projection bands below and above the cut.
    const planDepths = { projectionDepth: 1.5, projectionBelowDepth: 1.4, projectionAboveDepth: 0.8 };
    const planConfig = drawing.createSectionConfig('y', (b.min.y + b.max.y) / 2, planDepths);
    const plan = await cut.withCutGeometry(model.geometryResult.meshes, planConfig.plane, 1.5, (meshes) => generator.generate(meshes as MeshData[], planConfig,
      { includeProjection: true, includeEdges: true, includeHiddenLines: false, mergeLines: true, useGPU: false }));
    const round = (v: number) => Math.round(v * 1e5) / 1e5;
    const planLines = plan.lines.map((l) => `${l.entityId}:${l.category}:${round(l.line.start.x)},${round(l.line.start.y)}-${round(l.line.end.x)},${round(l.line.end.y)}`).sort();
    const polygons = capped.cutPolygons.map((p) => `${p.entityId}:${p.polygon.outer.map((q) => `${round(q.x)},${round(q.y)}`).join(' ')}`).sort();
    // Centre bounds of the first entity, folded as PropertiesPanel does (or from backed metadata once released).
    const target = model.geometryResult.meshes.find((m) => m.indices.length > 0 || provenance.isReleasedMesh(m))!.expressId;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], released = false;
    for (const m of model.geometryResult.meshes) {
      if (m.expressId !== target) continue;
      if (provenance.isReleasedMesh(m)) { released = true; continue; }
      const o = m.origin ?? [0, 0, 0];
      for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k] + o[k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v;
      }
    }
    if (released) { const backed = metaMod.releasedGeometryMetadata()!.bounds(id, target)!; min = [...backed.min]; max = [...backed.max]; }
    // Mesh areas, as the quantity summary collects them (resident) or the backing recorded them (released).
    const areas = area.collectMeshAreas([model.geometryResult.meshes]);
    for (const m of model.geometryResult.meshes) {
      if (!provenance.isReleasedMesh(m) || areas.has(m.expressId)) continue;
      const backed = metaMod.releasedGeometryMetadata()?.area(id, m.expressId);
      if (backed) areas.set(m.expressId, backed);
    }
    return { exportDigest: hash(unkeyed), exportedMeshes: exported.meshes.length,
      instancedExported: exported.meshes.filter((m) => m.occurrenceKey?.includes(':inst:')).length,
      planLines: planLines.length, planDigest: planLines,
      capPolygons: polygons.length, capDigest: polygons,
      centre: { target, min, max }, areas: [...areas].sort((x, y) => x[0] - y[0]).map(([k, v]) => [k, round(v.area), v.incomplete]) };
  }, [DRAWING, modelId, digestSource()] as const);
}

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
    // Small chunks: many per model, so readback leases a neighbourhood, not the whole model.
    await geometryBackingCommand(store, undefined, { action: 'start', options: { chunkBytes: 64 * 1024, queueBytes: 4 << 20 } });
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
    const toolsResident = await toolProbe(page, phase1.modelId);
    // Phase 2: test-only release, readback probes, and a full read-back digest.
    const report = await page.evaluate(async ([hookPath, digest, modelId, points]) => {
      const g = globalThis as Probe & typeof globalThis;
      const hash = (0, eval)(digest) as (meshes: MeshData[]) => string;
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
      for await (const shard of backing.reader.instancedShards()) { occurrences += shard.instances.length; templates += shard.templates.length; }
      return { after: hash(read), released, heldBefore, heldAfter, storeEmpty, snapsAfter, occurrences, templates, peakDecodedBytes: peak };
    }, [HOOK, digestSource(), phase1.modelId, phase1.points] as const);
    // The probes fed readback at the last grid point; the tap point is uncovered, so the tap reads back on demand.
    const tapReleased = await tapAndRead();
    const toolsReleased = await toolProbe(page, phase1.modelId);
    await writeFile(info.outputPath('tool-parity.json'), JSON.stringify({ resident: toolsResident, released: toolsReleased }, null, 2));
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
    expect(report.heldAfter).toBeLessThan(report.heldBefore);
    for (let k = 0; k < 3; k++) expect(Math.abs(tapReleased[k] - tapResident[k]), 'touch point after release').toBeLessThan(1e-6);
    // Exports (flat + instanced), caps, selection centre and quantities after release equal the resident outputs.
    expect(toolsResident.exportedMeshes as number).toBeGreaterThan(0);
    expect(toolsReleased).toEqual(toolsResident);
    if (report.occurrences > 0) expect(summary.instancedHits, 'instanced occurrences under the grid').toBeGreaterThan(0);
    expect(before.every((probe) => probe.outcome === 'resident')).toBe(true);
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = after[i];
      expect(b.expressId, `probe ${i} entity (${JSON.stringify({ a, b })})`).toBe(a.expressId);
      if (a.expressId === null) continue;
      expect(b.outcome, `probe ${i} came from readback`).toBe('fed');
      for (let k = 0; k < 3; k++) expect(Math.abs(b.point![k] - a.point![k]), `probe ${i} hit`).toBeLessThan(1e-6);
      expect(b.snap?.type, `probe ${i} snap kind`).toBe(a.snap?.type);
      if (a.snap) for (let k = 0; k < 3; k++) expect(Math.abs(b.snap!.position[k] - a.snap.position[k]), `probe ${i} snap`).toBeLessThan(1e-6);
    }
    // A real GPU device loss after release (#10264 PR8): the renderer replaces the device and the viewer
    // rebuilds the released scene from the backing, flat in bounded batches and instancing from shards.
    const canvasBox = (await page.locator('canvas').first().boundingBox())!;
    const shot = async () => (await page.screenshot({ clip: canvasBox })).toString('base64');
    const beforeLoss = await shot();
    const recovery = await page.evaluate(async ([points]) => {
      const g = globalThis as Probe;
      const hook = g.__ifc_lite_geometry_backing__!;
      const settle = async () => {
        for (let i = 0; i < 200 && !(g.__ifc_lite_scene_settled__?.()); i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      };
      const grid = async () => (await g.__ifc_lite_pick_parity__!({ columns: 48, rows: 32 })).rows
        .map((row) => (row.annotation ? null : row.gpu?.expressId ?? null));
      const [pose] = await hook({ action: 'camera-for-test' });
      const gpuBefore = await grid();
      const heldBefore = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      await hook({ action: 'lose-device-for-test' });
      const started = performance.now();
      let state = { lost: true, ready: false };
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        state = (await hook({ action: 'device-state-for-test' }))[0] as typeof state;
        if (!state.lost && state.ready) break;
      }
      const recoveredMs = Math.round(performance.now() - started);
      await hook({ action: 'camera-for-test', pose });
      await settle();
      const gpuAfter = await grid();
      const held = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      const snaps = await hook({ action: 'snap-probe-for-test', points });
      return { state, recoveredMs, gpuBefore, gpuAfter, heldBefore, held, snaps };
    }, [phase1.points] as const);
    const afterRecovery = await shot();
    await page.screenshot({ path: info.outputPath('after-recovery.png') });
    const pixels = await page.evaluate(async ([a, b]) => {
      const decode = async (base64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      let differing = 0;
      for (let i = 0; i < x.length; i += 4) {
        if (Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])) > 8) differing++;
      }
      return { total: x.length / 4, differing };
    }, [beforeLoss, afterRecovery] as const);
    const toolsRecovered = await toolProbe(page, phase1.modelId);
    const recovered = recovery.snaps as SnapRow[];
    const drawnTexels = recovery.gpuBefore.filter((id) => id !== null).length;
    const gpuDiffering = recovery.gpuBefore.filter((id, i) => id !== recovery.gpuAfter[i]).length;
    await writeFile(info.outputPath('device-recovery.json'), JSON.stringify({ state: recovery.state, recoveredMs: recovery.recoveredMs,
      heldBefore: recovery.heldBefore, held: recovery.held, gpuTexels: recovery.gpuBefore.length, drawnTexels, gpuDiffering, pixels,
      toolsMatch: JSON.stringify(toolsRecovered) === JSON.stringify(toolsResident) }, null, 2));
    expect(recovery.state, 'the renderer recovered from a real device loss').toEqual({ lost: false, ready: true });
    expect(drawnTexels, 'the released scene drew entities before the loss').toBeGreaterThan(100);
    expect(gpuDiffering, `GPU picks after recovery (${gpuDiffering} of ${recovery.gpuBefore.length} texels differ)`).toBe(0);
    expect(recovery.held, 'no CPU restore: recovery keeps no CPU pieces').toBeLessThanOrEqual(recovery.heldBefore);
    expect(pixels.differing / pixels.total, `${pixels.differing} of ${pixels.total} pixels differ after recovery`).toBeLessThan(0.002);
    expect(toolsRecovered, 'exports, caps, plans, centre and areas after recovery').toEqual(toolsResident);
    for (let i = 0; i < after.length; i++) {
      const a = after[i], b = recovered[i];
      expect(b.expressId, `recovered probe ${i} entity (${JSON.stringify({ a, b })})`).toBe(a.expressId);
      if (a.expressId === null) continue;
      for (let k = 0; k < 3; k++) expect(Math.abs(b.point![k] - a.point![k]), `recovered probe ${i} hit`).toBeLessThan(1e-6);
      expect(b.snap?.type, `recovered probe ${i} snap kind`).toBe(a.snap?.type);
    }
    // A content-version reload after release (realign, rebase, collab): the scene rebuilds from the
    // store list, whose released members are replayed from the backing in bounded batches.
    const reload = await page.evaluate(async ([points]) => {
      const g = globalThis as Probe;
      const store = g.__ifc_lite_viewer_store__! as unknown as { setState(fn: (s: { geometryContentVersion: number }) => object): void };
      // A rebuilt scene may refit the camera; probe from the same pose as before the reload.
      const [pose] = await g.__ifc_lite_geometry_backing__!({ action: 'camera-for-test' });
      // Independent of CPU and backing readback: what the GPU draws, by id buffer, on a texel grid.
      const gpuGrid = async () => (await g.__ifc_lite_pick_parity__!({ columns: 48, rows: 32 })).rows
        .map((row) => (row.annotation ? null : row.gpu?.expressId ?? null));
      const gpuBefore = await gpuGrid();
      store.setState((state) => ({ geometryContentVersion: state.geometryContentVersion + 1 }));
      // The replay is asynchronous: wait until the scene settles again and a reseal acknowledges the replacement.
      for (let i = 0; i < 200 && !(g.__ifc_lite_scene_settled__?.()); i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 1500));
      const sealed = await g.__ifc_lite_geometry_backing__!({ action: 'seal' });
      const held = (await g.__ifc_lite_cpu_geometry_held__!()).totalBytes;
      await g.__ifc_lite_geometry_backing__!({ action: 'camera-for-test', pose });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const snaps = await g.__ifc_lite_geometry_backing__!({ action: 'snap-probe-for-test', points });
      const gpuAfter = await gpuGrid();
      // Independent of readback: where the scene itself draws instanced occurrences after the reload.
      const instancedBounds = await g.__ifc_lite_geometry_backing__!({ action: 'instanced-bounds-for-test' });
      return { sealed, held, snaps, gpuBefore, gpuAfter, instancedBounds };
    }, [phase1.points] as const);
    await page.screenshot({ path: info.outputPath('after-reload.png') });
    await writeFile(info.outputPath('reload.json'), JSON.stringify({ sealed: reload.sealed, held: reload.held }, null, 2));
    expect(reload.sealed[0].complete, JSON.stringify(reload.sealed[0])).toBe(report.occurrences > 0 ? false : true);
    expect(reload.held, 'no CPU restore: the replay keeps no CPU pieces').toBeLessThanOrEqual(report.heldAfter);
    const reloaded = reload.snaps as SnapRow[];
    // Interim limit until instanced occurrences are restaged in place: a content bump loses a
    // model's instancing, its new generation is never complete, and released readback must then
    // fail closed (unavailable), never answer from a different or stale surface.
    const lost = reload.sealed[0].instancedLost === true;
    // The rebuilt scene itself, independent of readback: every GPU-picked texel names the same entity.
    const drawn = reload.gpuBefore.filter((id) => id !== null).length;
    const differing = reload.gpuBefore.filter((id, i) => id !== reload.gpuAfter[i]).length;
    expect(drawn, 'the released scene draws entities before the reload').toBeGreaterThan(100);
    expect(differing, `GPU picks after the reload (${differing} of ${reload.gpuBefore.length} texels differ)`).toBe(0);
    // Expected-unavailable only where a LOST instanced occurrence could matter, identified independently of
    // readback: the resident hit was instanced, or the scene draws an instanced occurrence within the
    // readback neighbourhood (1 m, placed frame) of the resident hit point. Every other hit is flat and
    // must answer exactly: entity, point and snap. (Final all-probe parity needs instanced restaging.)
    const R = 1;
    const occurrences = reload.instancedBounds as Array<{ id: number; bounds: { min: Record<'x' | 'y' | 'z', number>; max: Record<'x' | 'y' | 'z', number> } | null }>;
    const nearInstanced = (a: SnapRow) => a.instanced || occurrences.some(({ bounds: o }) => !!o && !!a.point
      && o.min.x <= a.point[0] + R && o.max.x >= a.point[0] - R && o.min.y <= a.point[1] + R && o.max.y >= a.point[1] - R
      && o.min.z <= a.point[2] + R && o.max.z >= a.point[2] - R);
    let unavailable = 0, expectedUnavailable = 0, flatHits = 0;
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = reloaded[i];
      const mayFail = lost && a.expressId !== null && nearInstanced(a);
      if (mayFail) expectedUnavailable++;
      if (b.outcome === 'unavailable') {
        unavailable++;
        expect(mayFail, `reload probe ${i} is a flat hit away from any instanced occurrence: it must answer (${JSON.stringify({ a, b })})`).toBe(true);
        continue;
      }
      expect(b.expressId, `reload probe ${i} entity (${JSON.stringify({ a, b })})`).toBe(a.expressId);
      if (a.expressId === null) continue;
      if (!mayFail) flatHits++;
      for (let k = 0; k < 3; k++) expect(Math.abs(b.point![k] - a.point![k]), `reload probe ${i} hit`).toBeLessThan(1e-6);
      expect(b.snap?.type, `reload probe ${i} snap kind`).toBe(a.snap?.type);
      if (a.snap) for (let k = 0; k < 3; k++) expect(Math.abs(b.snap!.position[k] - a.snap.position[k]), `reload probe ${i} snap`).toBeLessThan(1e-6);
    }
    await writeFile(info.outputPath('reload-probes.json'), JSON.stringify({ lost, unavailable, expectedUnavailable, flatHits, probes: before.length,
      gpuTexels: reload.gpuBefore.length, gpuDrawn: drawn, gpuDiffering: differing }));
    expect(flatHits, 'flat hits away from instancing answered with full parity').toBeGreaterThan(0);
    if (!lost) expect(unavailable, 'a complete reseal answers every probe').toBe(0);
    await page.evaluate(() => (globalThis as Probe).__ifc_lite_geometry_backing__!({ action: 'stop' }));
  });
}
