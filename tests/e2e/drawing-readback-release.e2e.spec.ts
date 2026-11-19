/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's own 2D drawing (DrawingRuntimeHost → useDrawingGeneration)
 * before and after the TEST-ONLY CPU release (#10264), on real public IFCs:
 * - resident: the drawing must equal an independent oracle, the array
 *   generator over the complete resident model (flat meshes plus every
 *   instanced occurrence the scene materializes);
 * - released: the store and scene arrays are gone, the same drawing request
 *   reads back from the real IndexedDB backing, and must draw the same.
 * Product release stays disabled; only `__ifc_lite_geometry_backing__` releases.
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

type Hook = typeof import('../../apps/viewer/src/lib/geometry-backing/backing-debug-hook');
type Drawing2DModule = typeof import('../../packages/drawing-2d/src/index');
type Drawing = import('../../packages/drawing-2d/src/types').Drawing2D;
type MeshData = import('@ifc-lite/geometry').MeshData;
type ViewerState = ReturnType<typeof import('../../apps/viewer/src/store').useViewerStore.getState>;
type ViewerStore = typeof import('../../apps/viewer/src/store').useViewerStore;
type Probe = typeof globalThis & {
  __ifc_lite_viewer_store__: ViewerStore;
  __ifc_lite_scene_settled__?: () => boolean;
  __ifc_lite_geometry_backing__?: (command: { action: string }) => Promise<unknown>;
  __ifc_lite_cpu_geometry_held__: () => Promise<{ totalBytes: number }>;
};
interface Canonical { lines: string[]; polygons: string[]; stats: Record<string, number> }
type Plane = { axis: 'down' | 'front' | 'side'; position: number; projection: boolean };
interface Scenario { name: string; files: string[]; planes: Plane[] }

const HOOK = '/src/lib/geometry-backing/backing-debug-hook.ts';
const SCENARIOS: Scenario[] = [
  { name: 'fzk-haus', files: ['tests/models/ara3d/AC20-FZK-Haus.ifc'],
    planes: [{ axis: 'down', position: 30, projection: false }, { axis: 'front', position: 45, projection: true }] },
  { name: 'duplex', files: ['tests/models/ara3d/duplex.ifc'],
    planes: [{ axis: 'down', position: 25, projection: false }, { axis: 'side', position: 50, projection: true }] },
  { name: 'georeferenced-minibim', files: ['tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc'],
    planes: [{ axis: 'down', position: 40, projection: false }, { axis: 'front', position: 50, projection: true }] },
  { name: 'federated', files: ['tests/models/ara3d/AC20-FZK-Haus.ifc', 'tests/models/ara3d/duplex.ifc'],
    planes: [{ axis: 'down', position: 30, projection: false }, { axis: 'front', position: 50, projection: true }] },
];

let server: ViewerDevServer;
test.skip(process.env.GEOMETRY_BACKING_GPU !== '1', 'Set GEOMETRY_BACKING_GPU=1 on a real WebGPU adapter; SwiftShader is not release evidence.');
test.beforeAll(async () => { server = await startViewerDevServer('drawing-readback-release'); });
test.afterAll(async () => { await server?.close(); });
test.describe.configure({ timeout: 900_000 });

/** Order-free view of a drawing, coordinates to 1e-4 m (page-side source). */
const CANONICAL = `(${(d: Drawing): Canonical => {
  const r = (v: number) => (Math.round(v * 1e4) / 1e4 + 0).toFixed(4);
  const pt = (p: { x: number; y: number }) => `${r(p.x)},${r(p.y)}`;
  const lines = d.lines.map((l) => [l.category, l.visibility, l.entityId, l.modelIndex, l.ifcType, l.openSurfaceCut ?? false,
    [pt(l.line.start), pt(l.line.end)].sort().join(' ')].join('|')).sort();
  const polygons = [...d.cutPolygons, ...(d.layerBaseCutPolygons ?? [])].map((p) => [p.entityId, p.modelIndex, p.ifcType,
    p.fillColor ? JSON.stringify(p.fillColor) : '', p.polygon.outer.map(pt).sort().join(' '),
    p.polygon.holes.map((h) => h.map(pt).sort().join(' ')).sort().join('/')].join('|')).sort();
  const { processingTimeMs: _t, ...stats } = d.stats;
  return { lines, polygons, stats };
}})`;

async function open(page: Page, files: string[]): Promise<void> {
  await page.goto(server.url);
  await page.waitForFunction(() => Boolean((globalThis as Probe).__ifc_lite_viewer_store__), null, { timeout: 180_000 });
  await page.evaluate(async (hookPath) => {
    const { geometryBackingCommand } = await import(hookPath) as Hook;
    await geometryBackingCommand((globalThis as Probe).__ifc_lite_viewer_store__, undefined,
      { action: 'start', options: { chunkBytes: 64 * 1024, queueBytes: 4 << 20 } });
  }, HOOK);
  for (const [index, file] of files.entries()) {
    await page.locator(index === 0 ? '#file-input-open' : '#file-input-add').setInputFiles(join(process.cwd(), file));
    await page.waitForFunction((count) => {
      const g = globalThis as Probe, s = g.__ifc_lite_viewer_store__.getState();
      return !s.loading && !s.geometryStreamingActive && s.models.size === count && g.__ifc_lite_scene_settled__?.()
        && Boolean(g.__ifc_lite_geometry_backing__);
    }, index + 1, { timeout: 480_000, polling: 250 });
  }
}

/** Ask the viewer for a drawing of `plane` and wait for the one it publishes. */
async function viewerDrawing(page: Page, plane: Plane): Promise<{ canonical: Canonical; svgLines: string[]; instancedEntities: number }> {
  return page.evaluate(async ([p, canonicalSource]) => {
    const store = (globalThis as Probe).__ifc_lite_viewer_store__;
    const prior = store.getState().drawing2D;
    store.setState({ drawing2DPanelVisible: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.setState((s: ViewerState) => ({
      drawing2DDisplayOptions: { ...s.drawing2DDisplayOptions, useSymbolicRepresentations: false, showConstructionProjection: p.projection,
        constructionProjectionDepth: null },
      sectionPlane: { ...s.sectionPlane, axis: p.axis, position: p.position, flipped: false, enabled: true, custom: undefined },
    }));
    store.setState({ drawing2DPanelVisible: true });
    const started = performance.now();
    for (;;) {
      const s = store.getState();
      if (s.drawing2DError) throw new Error(`viewer drawing failed: ${s.drawing2DError}`);
      if (s.drawing2DStatus === 'ready' && s.drawing2D && s.drawing2D !== prior) break;
      if (performance.now() - started > 300_000) throw new Error(`no drawing; status ${s.drawing2DStatus}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const drawing = store.getState().drawing2D!;
    const { exportToSVG } = await import('/@id/@ifc-lite/drawing-2d') as Drawing2DModule;
    const { getGlobalRenderer } = await import('/src/hooks/useBCF.ts') as typeof import('../../apps/viewer/src/hooks/useBCF');
    const instancedIds = new Set<number>(getGlobalRenderer()?.getScene().getInstancedEntityIds() ?? []);
    const drawn = new Set(drawing.lines.map((l) => l.entityId).filter((id) => id !== undefined && instancedIds.has(id)));
    const canonical = (0, eval)(canonicalSource) as (d: Drawing) => Canonical;
    return { canonical: canonical(drawing), svgLines: exportToSVG(drawing).split('\n').sort(), instancedEntities: drawn.size };
  }, [plane, CANONICAL] as const);
}

/** The independent oracle: the array generator over the complete resident model, with the hook's own config. */
async function oracleDrawing(page: Page, plane: Plane) {
  return page.evaluate(async ([p, canonicalSource]) => {
    const state = (globalThis as Probe).__ifc_lite_viewer_store__.getState();
    const { Drawing2DGenerator } = await import('/@id/@ifc-lite/drawing-2d') as Drawing2DModule;
    const { drawingMeshFilter } = await import('/src/lib/drawing/drawing-mesh-filter.ts') as typeof import('../../apps/viewer/src/lib/drawing/drawing-mesh-filter');
    const { drawingWithMaterialLayerFills } = await import('/src/lib/drawing/material-layer-fills.ts') as typeof import('../../apps/viewer/src/lib/drawing/material-layer-fills');
    const { createMeshOutlineProvider } = await import('/src/hooks/meshOutlineProvider.ts') as typeof import('../../apps/viewer/src/hooks/meshOutlineProvider');
    const { modelIndices } = await import('/src/lib/model-placement/model-indices.ts') as typeof import('../../apps/viewer/src/lib/model-placement/model-indices');
    const { placedMesh } = await import('/src/lib/model-placement/placed-geometry.ts') as typeof import('../../apps/viewer/src/lib/model-placement/placed-geometry');
    const { displayedTranslation } = await import('/src/lib/model-placement/state.ts') as typeof import('../../apps/viewer/src/lib/model-placement/state');
    const { resolveEntityRef } = await import('/src/store/resolveEntityRef.ts') as typeof import('../../apps/viewer/src/store/resolveEntityRef');
    const { getGlobalRenderer } = await import('/src/hooks/useBCF.ts') as typeof import('../../apps/viewer/src/hooks/useBCF');
    // The SAME wasm module instance the viewer initialised (same URL).
    const wasmUrl = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /ifc-lite(_bg)?\.js(\?|$)/.test(n) || /@ifc-lite_wasm\.js/.test(n));
    const wasm = (wasmUrl ? await import(wasmUrl) : {}) as { meshOutline2d?: Parameters<typeof createMeshOutlineProvider>[0] };
    const indices = modelIndices(state.models);
    const flat: MeshData[] = [];
    for (const [id, model] of state.models) {
      if (!model.visible || !model.geometryResult) continue;
      const modelIndex = indices.get(id) ?? 0;
      // The viewer's placed view geometry: index stamped, model placement applied.
      const translation = displayedTranslation(state.modelPlacement, id);
      for (const mesh of model.geometryResult.meshes) flat.push(placedMesh(mesh.modelIndex === modelIndex ? mesh : { ...mesh, modelIndex }, translation));
    }
    const typeOf = (globalId: number) => {
      const ref = resolveEntityRef(globalId);
      return state.models.get(ref.modelId)?.ifcDataStore?.entities.getTypeName(ref.expressId) || undefined;
    };
    const occurrences = (getGlobalRenderer()?.getScene().getAllInstancedMeshData() ?? [])
      .map((piece) => ({ ...piece, ifcType: typeOf(piece.expressId) }));
    const keep = drawingMeshFilter({ meshes: flat, typeVisibility: state.typeVisibility, structuralViewMode: state.structuralViewMode,
      retypedClasses: undefined, hiddenIds: state.hiddenEntities, isolatedIds: state.isolatedEntities, computedIsolatedIds: null });
    const config = structuredClone(state.drawing2D!.config);
    const generator = new Drawing2DGenerator();
    await generator.initialize();
    const drawing = drawingWithMaterialLayerFills(await generator.generate([...flat, ...occurrences].filter(keep), config, {
      includeHiddenLines: p.projection, includeProjection: p.projection, includeEdges: p.projection, mergeLines: true,
      outlineProvider: p.projection && typeof wasm.meshOutline2d === 'function' ? createMeshOutlineProvider(wasm.meshOutline2d) : undefined,
    }));
    generator.dispose();
    const canonical = (0, eval)(canonicalSource) as (d: Drawing) => Canonical;
    return { canonical: canonical(drawing), occurrences: occurrences.length, outline: typeof wasm.meshOutline2d === 'function' };
  }, [plane, CANONICAL] as const);
}

for (const scenario of SCENARIOS) {
  test(`viewer drawing of ${scenario.name} is unchanged by the test-only release`, async ({ page }, info) => {
    for (const file of scenario.files) test.skip(!existsSync(join(process.cwd(), file)), `${file} missing; run \`pnpm fixtures\``);
    await open(page, scenario.files);
    const resident: Array<{ viewer: Awaited<ReturnType<typeof viewerDrawing>>; oracle: { occurrences: number; outline: boolean } }> = [];
    for (const plane of scenario.planes) {
      const viewer = await viewerDrawing(page, plane);
      const oracle = await oracleDrawing(page, plane);
      expect(viewer.canonical.lines.length, `${plane.axis}: the drawing draws`).toBeGreaterThan(0);
      expect(viewer.canonical, `${plane.axis}: resident drawing equals the complete-model array oracle`).toEqual(oracle.canonical);
      resident.push({ viewer, oracle: { occurrences: oracle.occurrences, outline: oracle.outline } });
    }
    const released = await page.evaluate(async () => {
      const g = globalThis as Probe;
      const heldBefore = (await g.__ifc_lite_cpu_geometry_held__()).totalBytes;
      const status = await g.__ifc_lite_geometry_backing__!({ action: 'release-for-test' });
      const heldAfter = (await g.__ifc_lite_cpu_geometry_held__()).totalBytes;
      const storeEmpty = [...g.__ifc_lite_viewer_store__.getState().models.values()]
        .every((model) => model.geometryResult?.meshes.every((mesh) => mesh.positions.length === 0) ?? true);
      return { heldBefore, heldAfter, storeEmpty, status };
    });
    expect(released.storeEmpty).toBe(true);
    expect(released.heldAfter).toBeLessThan(released.heldBefore);
    const rows: unknown[] = [];
    for (const [index, plane] of scenario.planes.entries()) {
      const after = await viewerDrawing(page, plane);
      const before = resident[index].viewer;
      expect(after.canonical, `${plane.axis}: released drawing equals the resident one`).toEqual(before.canonical);
      expect(after.svgLines, `${plane.axis}: exported SVG`).toEqual(before.svgLines);
      rows.push({ plane, lines: before.canonical.lines.length, polygons: before.canonical.polygons.length,
        instancedEntitiesDrawn: before.instancedEntities, ...resident[index].oracle });
    }
    await writeFile(info.outputPath('drawing-readback-report.json'), JSON.stringify({ scenario, released, rows }, null, 2));
    await page.evaluate(() => (globalThis as Probe).__ifc_lite_geometry_backing__!({ action: 'stop' }));
  });
}
