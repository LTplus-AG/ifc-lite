// SPDX-License-Identifier: MPL-2.0
// #7955 M2-D: real built viewer, real host Worker and real staged SDK.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';
import type { LoadTraceSnapshot } from '../../packages/load-trace/src';
import { mappedInstancePixels } from './m11-instancing-pixels';

const WALL = 'rust/geometry/tests/fixtures/issue_098_wall_W.ifc';
const PRESENTATION = 'tests/fixtures/synthetic-retained/f-i-presentation.ifc';
const MAPPED = 'rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc';
const PIXEL = 'tests/fixtures/synthetic-retained/f-m11a-pixel.ifc';
// The same scene with both authored colours lost to grey: the pixel witness's negative control.
const PIXEL_GREY = 'tests/fixtures/synthetic-retained/f-m11a-pixel-grey.ifc';
const engine = process.env.IFCLITE_RETAINED_ENGINE;
// Trace DOM snapshots add work to the Cancel latency sample; keep real UI/Worker
// assertions and failure screenshots, without tracing this timing-sensitive file.
test.use({ trace: 'off' });
const SKIP = 'SKIP: no staged SMLib engine; this is NOT parity evidence';
interface ViewerGlobals {
  __ifc_lite_viewer_store__: { getState(): ViewerState; subscribe(listener: (state: ViewerState) => void): () => void };
  __retainedCancel?: {
    clickMs: number; clickEpochMs: number; before: { meshIds: number[]; published: number }; error?: string;
    /** Page clock when the viewer called `terminate()` on the retained host Worker. */
    terminatedMs?: number;
    /** Page clock when the store first carried the cancelled rows. */
    cancelledMs?: number;
  };
  __IFC_LITE_LOAD_TRACE__: { latest(): LoadTraceSnapshot | null };
  __retainedLongTasks: number[];
  /** Installed by the viewport once its renderer is ready: the parts the renderer's scene holds for one owner. */
  __ifc_lite_scene_owner__?: (globalId: number) => SceneOwnerSnapshot;
  __m11Fi?: { shards: number; occurrenceIds: number[] };
  __m11I?: { draws: number; shards: { templates: number; instances: number; triangles: number }[] };
}
// The base manifest plus every per-slice fragment: a model belongs to exactly one of them.
const COVERAGE_FRAGMENTS = 'tests/manifests/cli-retained-coverage.d';
const coverageFiles = () => ['tests/manifests/cli-retained-coverage.tsv',
  ...readdirSync(COVERAGE_FRAGMENTS).filter(name => name.endsWith('.tsv')).sort().map(name => `${COVERAGE_FRAGMENTS}/${name}`)];
const expected = (model: string) => coverageFiles().flatMap(path => readFileSync(path, 'utf8').split(/\r?\n/))
  .map(line => line.split('\t')).filter(row => row[0] === model)
  .map(([, id, status, code]) => ({ id: Number(id), status, code })).sort((a, b) => a.id - b.id);

async function setup(page: Page, kernel?: 'retained' | 'exact') {
  await page.addInitScript(() => {
    const globals = globalThis as typeof globalThis & ViewerGlobals;
    globals.__retainedLongTasks = [];
    new PerformanceObserver(list => {
      globals.__retainedLongTasks.push(...list.getEntries().map(e => e.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`/?perfTrace=1${kernel ? `&kernel=${kernel}` : ''}`);
  await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__));
  await expect(page.locator('#file-input-open')).toBeAttached();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const globals = globalThis as typeof globalThis & ViewerGlobals;
    const state = globals.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return { loading: state.loading, error: state.error, models: state.models.size, summary: model?.retainedGeometry,
      loadState: model?.loadState,
      meshIds: [...new Set((model?.geometryResult?.meshes ?? []).map(m => state.resolveGlobalIdFromModels(m.expressId)?.expressId))].sort((a, b) => (a ?? 0) - (b ?? 0)),
      selected: state.selectedEntityId === null ? null : state.resolveGlobalIdFromModels(state.selectedEntityId)?.expressId,
      spans: globals.__IFC_LITE_LOAD_TRACE__?.latest()?.spans.map(s => s.name),
      longTaskMs: globals.__retainedLongTasks.reduce((a, b) => a + b, 0),
    };
  });
}
async function complete(page: Page, retained: boolean) {
  await page.waitForFunction(retained => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return !state.loading && model?.loadState === 'complete' && (!retained || model.retainedGeometry?.completeness !== 'running');
  }, retained);
}
async function record(name: string, result: unknown) {
  console.log(`M2-D ${name}: ${JSON.stringify(result)}`);
  if (process.env.IFCLITE_VIEWER_OUT) {
    await mkdir(process.env.IFCLITE_VIEWER_OUT, { recursive: true });
    await writeFile(join(process.env.IFCLITE_VIEWER_OUT, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
  }
}

/** What the renderer's own colour attachment shows once one product is framed alone. */
interface FrameWitness {
  png: string;
  width: number;
  height: number;
  /** Pixels differing from the frame's background. */
  object: number;
  /** Of those, how many sit nearest (by hue angle) to each palette colour. */
  share: Record<string, number>;
  mean: number[];
}
/** The renderer's colour attachment (framebuffer readback; the compositor may discard a WebGPU canvas) classified against a palette. */
function readFrame(page: Page, palette: Record<string, number[]>): Promise<FrameWitness | null> {
  return page.evaluate(async palette => {
    const host = globalThis as unknown as { __ifc_lite_capture_color_frame__?: () => Promise<string | null> };
    const png = (await host.__ifc_lite_capture_color_frame__?.()) ?? null;
    if (!png) return null;
    const bitmap = await createImageBitmap(await (await fetch(png)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { width, height } = bitmap;
    const { data } = context.getImageData(0, 0, width, height);
    bitmap.close();
    const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
    const candidates = Object.entries(palette).map(([name, rgb]) => ({ name, rgb: unit(rgb) }));
    const share = Object.fromEntries(candidates.map(({ name }) => [name, 0]));
    const mean = [0, 0, 0];
    let object = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.max(Math.abs(data[i] - data[0]), Math.abs(data[i + 1] - data[1]), Math.abs(data[i + 2] - data[2])) <= 8) continue;
      object++;
      for (let c = 0; c < 3; c++) mean[c] += data[i + c] / 255;
      // Near-black pixels have no reliable hue; retain them in the object denominator.
      if (Math.max(data[i], data[i + 1], data[i + 2]) < 16) continue;
      // Shading scales a colour, it does not turn it: the nearest palette direction is the product's hue.
      const p = unit([data[i], data[i + 1], data[i + 2]]);
      let best = candidates[0], bestDot = -1;
      for (const candidate of candidates) {
        const dot = p[0] * candidate.rgb[0] + p[1] * candidate.rgb[1] + p[2] * candidate.rgb[2];
        if (dot > bestDot) { best = candidate; bestDot = dot; }
      }
      share[best.name]++;
    }
    return { png, width, height, object, share, mean: mean.map(v => v / Math.max(object, 1)) };
  }, palette);
}
/**
 * Show only `globalId`, frame the camera on it, and read the renderer's colour frame until it has settled (the
 * framing animates): two consecutive frames with the same, non-trivial object coverage. A renderer that returns
 * no frame, or never settles, fails; nothing here degrades to a weaker check.
 */
async function framedWitness(page: Page, globalId: number, palette: Record<string, number[]>): Promise<FrameWitness> {
  await page.evaluate(id => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    state.clearEntitySelection();
    state.showAll();
    state.isolateEntity(id);
    state.cameraCallbacks.frameEntities!([id]);
  }, globalId);
  const deadline = Date.now() + 60_000;
  let previous = -1, frame: FrameWitness | null = null, captures = 0, empty = 0, last = 'no frame requested';
  while (Date.now() < deadline) {
    const read = await readFrame(page, palette);
    captures++;
    if (read === null) empty++;
    else last = `${read.width}x${read.height}, ${read.object} object pixels`;
    const covered = read !== null && read.object >= read.width * read.height * 0.02;
    if (covered && read!.object === previous) { frame = read; break; }
    previous = read?.object ?? -1;
    await page.waitForTimeout(300);
  }
  expect(frame, `renderer colour frame of #${globalId}: captured, covered by the framed product, and settled (${captures} captures, ${empty} empty, last ${last})`).not.toBeNull();
  return frame!;
}
const SHARE = 0.9;
/** The authored hue must own at least SHARE of the product's pixels; shading and anti-aliasing take the rest. */
const shareOf = (frame: FrameWitness, name: string) => frame.share[name] / frame.object;
async function keepFrame(name: string, frame: FrameWitness) {
  if (process.env.IFCLITE_VIEWER_OUT) {
    await mkdir(process.env.IFCLITE_VIEWER_OUT, { recursive: true });
    await writeFile(join(process.env.IFCLITE_VIEWER_OUT, `${name}.png`), Buffer.from(frame.png.split(',')[1], 'base64'));
  }
}

test.describe('retained viewer acceptance', () => {
  test.skip(!(engine && existsSync(join(engine, 'engine-manifest.json'))), SKIP);

  test('M11-I: one verified shard renders all 64 mapped occurrences', async ({ page }) => {
    await page.addInitScript(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals;
      globals.__m11I = { draws: 0, shards: [] };
      const proto = (globalThis as unknown as { GPURenderPassEncoder?: { prototype: {
        drawIndexed(...args: number[]): void;
      } } }).GPURenderPassEncoder?.prototype;
      if (!proto) return;
      const draw = proto.drawIndexed;
      proto.drawIndexed = function (...args: number[]) {
        if (args[1] === 64) globals.__m11I!.draws++;
        return draw.apply(this, args);
      };
    });
    await setup(page, 'retained');
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals;
      const seen = new Set<ArrayBuffer>();
      globals.__ifc_lite_viewer_store__.subscribe(state => {
        for (const { bytes } of state.pendingInstancedShards ?? []) {
          if (seen.has(bytes)) continue;
          seen.add(bytes);
          const header = new DataView(bytes);
          globals.__m11I!.shards.push({ templates: header.getUint32(8, true),
            instances: header.getUint32(12, true), triangles: header.getUint32(24, true) / 3 * header.getUint32(12, true) });
        }
      });
    });
    // #7955: move the storey outside the initial camera's frustum. A near-origin
    // fixture can show a few occurrences even when automatic fitting is absent.
    const source = readFileSync(MAPPED, 'utf8');
    const shifted = source.replace('#22=IFCLOCALPLACEMENT(#20,#2);',
      '#10001=IFCCARTESIANPOINT((500.,0.,0.));\n#10002=IFCAXIS2PLACEMENT3D(#10001,$,$);\n#22=IFCLOCALPLACEMENT(#20,#10002);');
    expect(shifted).not.toBe(source);
    await page.locator('#file-input-open').setInputFiles({ name: 'mapped-offset500.ifc',
      mimeType: 'application/ifc', buffer: Buffer.from(shifted) });
    await complete(page, true);
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__m11I!.draws)).toBeGreaterThan(0);
    const result = await snapshot(page);
    expect(result.error).toBeNull();
    expect(result.summary?.published).toBe(64);
    expect(result.summary?.refused).toEqual([]);
    const faces = result.summary?.faces ?? {};
    expect(Object.keys(faces)).toHaveLength(64);
    expect(faces[31]).toHaveLength(6);
    for (const face of faces[31]) expect(face.areaM2).toBe(1);
    for (const rows of Object.values(faces)) expect(rows).toEqual(faces[31]);
    const observed = await page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__m11I!);
    expect(observed.shards).toHaveLength(1);
    expect(observed.shards[0]).toMatchObject({ templates: 1, instances: 64 });
    expect(observed.shards[0].triangles).toBeGreaterThan(0);
    const pixels = await mappedInstancePixels(page);
    await record('m11-i-instancing', { ...observed, summary: result.summary, flatProducts: result.meshIds.length, spans: result.spans, pixels: pixels.evidence });
    if (process.env.IFCLITE_VIEWER_OUT) await writeFile(join(process.env.IFCLITE_VIEWER_OUT, 'm11-i-instancing-gpu.png'), pixels.png);
    if (process.env.IFCLITE_VIEWER_OUT) await page.screenshot({ path: join(process.env.IFCLITE_VIEWER_OUT, 'm11-i-instancing.png') });
  });

  test('M11-I: f-i case (c) emits an instanced shard', async ({ page }) => {
    await setup(page, 'retained');
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals;
      const seen = new Set<ArrayBuffer>(), caseIds = new Set([311,321,331,341,351,361,371,381,391]);
      globals.__m11Fi = { shards: 0, occurrenceIds: [] };
      globals.__ifc_lite_viewer_store__.subscribe(state => {
        for (const { bytes } of state.pendingInstancedShards ?? []) {
          if (seen.has(bytes)) continue;
          seen.add(bytes);
          const wire = new DataView(bytes), templates = wire.getUint32(8, true);
          const stride = wire.getUint32(4, true) >= 2 ? wire.getUint32(28, true) || 88 : 88;
          const ids = Array.from({ length: wire.getUint32(12, true) }, (_, i) =>
            wire.getUint32(32 + templates * 48 + i * stride + 4, true)).filter(id => caseIds.has(id));
          if (ids.length > 0) { globals.__m11Fi!.shards++;globals.__m11Fi!.occurrenceIds.push(...ids); }
        }
      });
    });
    await page.locator('#file-input-open').setInputFiles(resolve(PRESENTATION));
    await complete(page, true);
    const result = await snapshot(page);
    expect(result.error).toBeNull();
    const observed = await page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__m11Fi!);
    expect(observed.shards, '§7.4: a real IFNS shard contains f-i case (c) occurrences').toBeGreaterThan(0);
    // c9 is a raw-coordinate outlier: its pairing verifier may correctly keep
    // it flat. Require the group, never force that occurrence past verification.
    await record('m11-i-f-i-c', { ...observed, farOccurrenceInstanced: observed.occurrenceIds.includes(391),
      farOccurrenceFlat: result.meshIds.includes(391), summary: result.summary });
  });

  test('M11-A x M11-I: one shard, every occurrence keeps its own authored colour', async ({ page }) => {
    await setup(page, 'retained');
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals;
      const seen = new Set<ArrayBuffer>();
      globals.__m11I = { draws: 0, shards: [] };
      (globals as typeof globals & { __m11Colours?: Record<number, number[]> }).__m11Colours = {};
      globals.__ifc_lite_viewer_store__.subscribe(state => {
        for (const { bytes } of state.pendingInstancedShards ?? []) {
          if (seen.has(bytes)) continue;
          seen.add(bytes);
          // Header u32s: magic, version, templates, instances, ..., stride at +28 (a v1 shard has none: 88).
          const wire = new DataView(bytes), templates = wire.getUint32(8, true), instances = wire.getUint32(12, true);
          const stride = wire.getUint32(4, true) >= 2 ? wire.getUint32(28, true) || 88 : 88;
          globals.__m11I!.shards.push({ templates, instances, triangles: 0 });
          for (let i = 0; i < instances; i++) {
            const record = 32 + templates * 48 + i * stride;
            (globals as typeof globals & { __m11Colours: Record<number, number[]> }).__m11Colours[wire.getUint32(record + 4, true)] =
              [0, 4, 8, 12].map(offset => wire.getFloat32(record + 8 + offset, true));
          }
        }
      });
    });
    // One shared representation map and one shared leaf: the geometry is byte-equal, so the instance key is too.
    // Each occurrence's own IfcMappedItem carries the style, which an unstyled leaf takes as its element colour.
    const source = readFileSync(MAPPED, 'utf8');
    const styles = '#20001=IFCCOLOURRGB($,0.9,0.1,0.1);#20002=IFCSURFACESTYLERENDERING(#20001,0.,$,$,$,$,$,$,.NOTDEFINED.);'
      + '#20003=IFCSURFACESTYLE($,.BOTH.,(#20002));#20004=IFCCOLOURRGB($,0.1,0.1,0.9);'
      + '#20005=IFCSURFACESTYLERENDERING(#20004,0.,$,$,$,$,$,$,.NOTDEFINED.);#20006=IFCSURFACESTYLE($,.BOTH.,(#20005));\n'
      + Array.from({ length: 64 }, (_, i) => `#${20010 + i}=IFCSTYLEDITEM(#${25 + 7 * i},(#${i % 2 === 0 ? 20003 : 20006}),$);`).join('\n') + '\n';
    const styled = source.replace('ENDSEC;\nEND-ISO', `${styles}ENDSEC;\nEND-ISO`);
    expect(styled, 'the fixture ends with a single DATA section').not.toBe(source);
    await page.locator('#file-input-open').setInputFiles({ name: 'mapped-two-colours.ifc',
      mimeType: 'application/ifc', buffer: Buffer.from(styled) });
    await complete(page, true);
    const result = await snapshot(page);
    expect(result.error).toBeNull();
    expect(result.summary?.published).toBe(64);
    expect(result.summary?.refused).toEqual([]);
    const observed = await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals & { __m11Colours: Record<number, number[]> };
      return { shards: globals.__m11I!.shards, colours: globals.__m11Colours };
    });
    // The same geometry still groups into ONE template: appearance is per instance, never part of the grouping key.
    expect(observed.shards).toHaveLength(1);
    expect(observed.shards[0]).toMatchObject({ templates: 1, instances: 64 });
    const near = (actual: number[], expected: number[]) => actual.every((v, i) => Math.abs(v - expected[i]) < 1e-3);
    const red = [0.9, 0.1, 0.1, 1], blue = [0.1, 0.1, 0.9, 1];
    for (let i = 0; i < 64; i++) {
      const colour = observed.colours[31 + 7 * i];
      expect(colour, `occurrence #${31 + 7 * i} has a shard colour`).toBeDefined();
      expect(near(colour, i % 2 === 0 ? red : blue), `occurrence #${31 + 7 * i}: ${JSON.stringify(colour)}`).toBe(true);
    }
    await record('m11-a-x-m11-i', { shards: observed.shards, red: 32, blue: 32, colours: observed.colours });
  });

  test('positive: current corpus outcomes are absent/listed, with no exact cache lookup', async ({ page }) => {
    const requests: string[] = [];
    page.context().on('request', req => requests.push(req.url()));
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(WALL));
    await complete(page, true);
    const result = await snapshot(page), rows = expected(WALL);
    expect(result.error).toBeNull();
    expect(result.summary?.published).toBe(rows.filter(p => p.status === 'published').length);
    expect(result.summary?.candidates).toBe(rows.length);
    expect(result.summary?.refused.map(p => ({ id: p.expressId, code: p.code })).sort((a, b) => a.id - b.id))
      .toEqual(rows.filter(p => p.status === 'refused').map(({ id, code }) => ({ id, code })));
    expect(result.meshIds).toEqual(rows.filter(p => p.status === 'published').map(p => p.id));
    expect(result.spans?.length).toBeGreaterThan(0);
    expect(result.spans).not.toContain('cache.lookup');
    expect(requests.some(url => url.includes('/smlib/'))).toBe(true);
    expect(requests.some(url => url.includes('/retained-engine/pkg-retained/'))).toBe(true);
    const chip = page.locator('[data-retained-chip="incomplete"]');
    await expect(chip).toContainText(`${result.summary?.published}/${rows.length}`);
    await chip.click();
    await expect(page.locator('[data-retained-state="incomplete"]')).toBeVisible();
    await expect(page.locator('[data-retained-row]')).toHaveCount(result.summary!.refused.length);
    for (const row of result.summary!.refused) {
      await expect(page.locator(`[data-retained-row="${row.expressId}"]`)).toHaveAttribute('data-code', row.code);
    }
    const refused = result.summary!.refused[0].expressId;
    await page.getByRole('button', { name: `Select #${refused}`, exact: true }).click();
    expect((await snapshot(page)).selected).toBe(refused);
    await record('positive', result);
    if (process.env.IFCLITE_VIEWER_OUT) {
      await page.screenshot({ path: join(process.env.IFCLITE_VIEWER_OUT, 'positive.png') });
    }
  });

  // M11-A. Three levels, every one REQUIRED, all against the colours hand-authored in generate-appearance.py
  // (never read back from the path under test): (1) the colour the viewer hands the renderer, (2) the colour the
  // renderer's own scene holds, (3) the pixels the renderer draws, read from its colour attachment with each
  // product framed alone. The scene hooks and the colour-frame hook are installed once the renderer has a
  // WebGPU device; their absence fails the test instead of weakening it to a store check.
  const authored = (fixture = PIXEL) => (JSON.parse(readFileSync(fixture.replace(/\.ifc$/, '.oracle.json'), 'utf8')) as
    { products: { role: string; id: number; rgba: number[] }[] }).products;
  const palette = () => ({ ...Object.fromEntries(authored().map(p => [p.role, p.rgba.slice(0, 3)])), grey: authored(PIXEL_GREY)[0].rgba.slice(0, 3) });
  const storedColours = (page: Page) => page.evaluate(() => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return { retained: model?.retainedGeometry !== undefined,
      meshes: (model?.geometryResult?.meshes ?? []).map(m => ({ global: m.expressId, id: state.resolveGlobalIdFromModels(m.expressId)?.expressId,
        color: [...m.color], geometryItemId: m.geometryItemId })) };
  });
  const rendererHooks = (page: Page) => page.waitForFunction(() => {
    const host = globalThis as typeof globalThis & ViewerGlobals & { __ifc_lite_capture_color_frame__?: unknown };
    return typeof host.__ifc_lite_scene_owner__ === 'function' && typeof host.__ifc_lite_capture_color_frame__ === 'function';
  }, undefined, { timeout: 60_000 });

  test('M11-A: the renderer is handed, holds and draws each retained product\'s authored colour', async ({ page }) => {
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(PIXEL));
    await complete(page, true);
    const { retained, meshes } = await storedColours(page);
    expect(retained).toBe(true);
    const evidence: Record<string, unknown> = { store: meshes };
    for (const product of authored()) {
      const own = meshes.filter(m => m.id === product.id);
      expect(own.length, `${product.role} meshes in the viewer store`).toBe(1);
      product.rgba.forEach((v, i) => expect(own[0].color[i], `${product.role} store channel ${i}`).toBeCloseTo(v, 5));
    }
    await rendererHooks(page);
    // The scene is fed from the store on the animation loop, so poll for the parts instead of trusting the load event.
    const scene: unknown[] = [], pixels: unknown[] = [];
    evidence.scene = scene; evidence.pixels = pixels;
    for (const product of authored()) {
      const global = meshes.find(m => m.id === product.id)!.global;
      const owner = () => page.evaluate(id => (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_scene_owner__!(id), global);
      await expect.poll(async () => (await owner()).flat?.length ?? 0, { timeout: 45_000, intervals: [500] }).toBeGreaterThan(0);
      const parts = (await owner()).flat!;
      expect(parts.length, `${product.role} parts in the renderer scene`).toBe(1);
      product.rgba.forEach((v, i) => expect(parts[0].color[i], `${product.role} scene channel ${i}`).toBeCloseTo(v, 5));
      scene.push({ role: product.role, color: parts[0].color, geometryItemId: parts[0].geometryItemId });
      const frame = await framedWitness(page, global, palette());
      await keepFrame(`appearance-${product.role}`, frame);
      pixels.push({ role: product.role, object: frame.object, share: frame.share, mean: frame.mean, width: frame.width, height: frame.height });
      expect(shareOf(frame, product.role), `${product.role}: share of its pixels nearest the authored hue ${JSON.stringify(frame.share)}`).toBeGreaterThanOrEqual(SHARE);
    }
    await record('appearance', evidence);
    if (process.env.IFCLITE_VIEWER_OUT) await page.screenshot({ path: join(process.env.IFCLITE_VIEWER_OUT, 'appearance.png') });
  });

  test('M11-A: the pixel witness fails when the authored colour is lost (grey twin of the same scene)', async ({ page }) => {
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(PIXEL_GREY));
    await complete(page, true);
    const { meshes } = await storedColours(page);
    await rendererHooks(page);
    const evidence: unknown[] = [];
    for (const product of authored(PIXEL_GREY)) {
      const global = meshes.find(m => m.id === product.id)!.global;
      const frame = await framedWitness(page, global, palette());
      await keepFrame(`appearance-lost-${product.role}`, frame);
      evidence.push({ role: product.role, object: frame.object, share: frame.share, mean: frame.mean });
      // The colour the viewer was given is grey, so the authored hue must own (almost) none of the pixels...
      expect(shareOf(frame, product.role), `${product.role}: lost colour must not read as the authored hue ${JSON.stringify(frame.share)}`).toBeLessThan(0.02);
      // ...and the witness must see the grey that is there (the same classifier, so the probe itself is live).
      expect(shareOf(frame, 'grey'), `${product.role}: the lost colour is the grey ${JSON.stringify(frame.share)}`).toBeGreaterThanOrEqual(SHARE);
    }
    await record('appearance-lost', evidence);
  });

  test('M11-A: the default exact path never takes the retained route and draws the same authored colours', async ({ page }) => {
    const requests: string[] = [];
    page.context().on('request', req => requests.push(req.url()));
    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(resolve(PIXEL));
    await complete(page, false);
    const { retained, meshes } = await storedColours(page);
    // No retained summary and no retained engine, Worker or SDK request: the retained appearance was not involved.
    expect(retained).toBe(false);
    expect(requests.filter(url => /\/smlib\/|pkg-retained|\/retained-engine\//.test(url))).toEqual([]);
    // Exact resolves these two products through the same resolver, so its colours are the authored ones too. Its browser
    // batch carries colour as RGBA8 (0.9 arrives as 230/255), so compare within one 8-bit step; the retained path above
    // is exact to f32.
    for (const product of authored()) {
      const own = meshes.filter(m => m.id === product.id);
      expect(own.length, `${product.role} meshes in the viewer store`).toBeGreaterThan(0);
      for (const mesh of own) product.rgba.forEach((v, i) => expect(Math.abs(mesh.color[i] - v), `${product.role} exact channel ${i}`).toBeLessThanOrEqual(1 / 255));
    }
    // Control: the same pixel witness on the exact path's own frame, so the retained pixels above are read against a
    // renderer that is known to show these colours.
    await rendererHooks(page);
    const evidence: unknown[] = [];
    for (const product of authored()) {
      const frame = await framedWitness(page, meshes.find(m => m.id === product.id)!.global, palette());
      evidence.push({ role: product.role, object: frame.object, share: frame.share, mean: frame.mean });
      expect(shareOf(frame, product.role), `${product.role} (exact): ${JSON.stringify(frame.share)}`).toBeGreaterThanOrEqual(SHARE);
    }
    await record('appearance-exact', evidence);
    if (process.env.IFCLITE_VIEWER_OUT) await page.screenshot({ path: join(process.env.IFCLITE_VIEWER_OUT, 'appearance-exact.png') });
  });

  test('a retained federated add is refused before any SDK request', async ({ page }) => {
    const requests: string[] = [];
    page.context().on('request', req => requests.push(req.url()));
    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
    await complete(page, false);
    await page.evaluate(() => {
      sessionStorage.setItem('ifc-lite:geometry-kernel', 'retained');
      history.replaceState(null, '', '/?kernel=retained&perfTrace=1');
    });
    await page.locator('#file-input-add').setInputFiles(resolve(WALL));
    await expect.poll(async () => (await snapshot(page)).error).toMatch(/Retained geometry loads one model at a time/);
    expect((await snapshot(page)).models).toBe(1);
    expect(requests.filter(url => /\/smlib\/|pkg-retained|\/retained-engine\//.test(url))).toEqual([]);
  });

  test('Cancel terminates the real host within 1 s and keeps published meshes', async ({ page }) => {
    await setup(page, 'retained');
    // #7955: a Node-side snapshot between first batch and click can take
    // seconds under GPU load and let this small model finish. Observe the first
    // append in-page and click the real DOM button in the same microtask turn.
    // Node's wall clock when Playwright saw the real host close: CDP transport
    // included, so attribution only. The 1 s contract is timed in the page.
    const closed = new Promise<number>(done => page.on('worker', host => {
      if (/retained\.worker/.test(host.url())) host.once('close', () => done(Date.now()));
    }));
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals;
      const store = globals.__ifc_lite_viewer_store__;
      // #8341: time the page's own termination of the retained host and the
      // store publication of its cancelled rows, both on the page clock. The
      // client creates its Worker lazily, after this, through the global.
      const NativeWorker = globalThis.Worker;
      const hosts = new WeakSet<Worker>();
      globalThis.Worker = new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget) as Worker;
          if (/retained\.worker/.test(String(args[0]))) hosts.add(worker);
          return worker;
        },
      });
      const terminate = NativeWorker.prototype.terminate;
      NativeWorker.prototype.terminate = function (this: Worker) {
        terminate.call(this);
        const cancel = globals.__retainedCancel;
        if (hosts.has(this) && cancel && cancel.terminatedMs === undefined) cancel.terminatedMs = performance.now();
      };
      const unpublished = store.subscribe(state => {
        const cancel = globals.__retainedCancel;
        const summary = [...state.models.values()][0]?.retainedGeometry;
        if (!cancel || !summary?.cancelled || summary.completeness !== 'incomplete') return;
        unpublished();
        cancel.cancelledMs = performance.now();
      });
      const unsubscribe = store.subscribe(state => {
        const model = [...state.models.values()][0];
        if (!model?.geometryResult?.meshes.length || model.retainedGeometry?.completeness !== 'running') return;
        unsubscribe();
        queueMicrotask(() => {
          const current = [...store.getState().models.values()][0];
          // This is a primary load, before finalization/ID registration. The
          // single-model stream carries the fixture's express IDs directly.
          const meshIds = [...new Set(current.geometryResult!.meshes.map(mesh => mesh.expressId))];
          const button = [...document.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Cancel').at(-1);
          const clickMs = performance.now();
          globals.__retainedCancel = { clickMs, clickEpochMs: performance.timeOrigin + clickMs,
            before: { meshIds, published: current.retainedGeometry!.published } };
          if (!button || button.disabled || current.retainedGeometry?.completeness !== 'running') {
            globals.__retainedCancel.error = 'No enabled Cancel button during the first published batch';
            return;
          }
          button.click();
        });
      });
    });
    await page.locator('#file-input-open').setInputFiles(resolve(WALL));
    await page.waitForFunction(() => Boolean((globalThis as typeof globalThis & ViewerGlobals).__retainedCancel));
    const clicked = await page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__retainedCancel!);
    expect(clicked.error).toBeUndefined();
    expect(clicked.before.meshIds.length).toBeGreaterThan(0);
    // The real host must still close, as Playwright observes it (untimed).
    const closedEpochMs = await closed;
    await page.waitForFunction(() => (globalThis as typeof globalThis & ViewerGlobals).__retainedCancel?.cancelledMs !== undefined);
    const click = await page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__retainedCancel!);
    const before = click.before;
    await complete(page, true);
    const after = await snapshot(page);
    expect(click.terminatedMs, 'the page never terminated the retained host Worker').toBeDefined();
    const terminateMs = click.terminatedMs! - click.clickMs;
    const publishMs = click.cancelledMs! - click.clickMs;
    expect(terminateMs, 'Cancel to retained host terminate(), page clock').toBeLessThanOrEqual(1000);
    expect(publishMs, 'Cancel to cancelled rows in the store, page clock').toBeLessThanOrEqual(1000);
    expect(after.summary!.cancelled).toBeGreaterThan(0);
    // #7955: this fixture streams flat walls so Cancel can run before a
    // 256-product instance flush. Refusals already reported before cancellation
    // retain their real codes; only products not yet published are cancelled.
    const wallOutcomes = expected(WALL);
    for (const row of after.summary!.refused.filter(row => row.code !== 'cancelled')) {
      expect(wallOutcomes).toContainEqual({ id: row.expressId, status: 'refused', code: row.code });
    }
    expect(after.summary!.cancelled).toBe(after.summary!.refused.filter(row => row.code === 'cancelled').length);
    expect(after.summary!.published + after.summary!.refused.length).toBe(wallOutcomes.length);
    for (const id of before.meshIds) expect(after.meshIds).toContain(id);
    for (const row of after.summary!.refused) expect(after.meshIds).not.toContain(row.expressId);
    expect(after.meshIds).toHaveLength(after.summary!.published);
    await record('cancel', {
      cancelMs: Math.max(terminateMs, publishMs), terminateMs, publishMs,
      observedCloseMs: closedEpochMs - click.clickEpochMs,
      measurement: 'page clock from the Cancel click to the host terminate() call and to the cancelled-row store publication; observedCloseMs is Playwright-observed Worker close on the wall clock, CDP transport included, attribution only',
      before, after,
    });
  });

  test('flagged preview with an empty engine fails before listening', async () => {
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn('pnpm', ['--filter', '@ifc-lite/viewer', 'exec', 'vite', 'preview', '--port', '0'], {
        env: { ...process.env, VITE_RETAINED_GEOMETRY: 'on', IFCLITE_RETAINED_ENGINE: '', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      let output = '';
      const timeout = setTimeout(() => {
        // pnpm owns a Vite child: terminate our process group on failure too.
        if (process.platform === 'win32') child.kill();
        else if (child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error(error); }
        }
        reject(new Error(`Invalid engine preview failed to exit: ${output}`));
      }, 30_000);
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      // `close` fires after stdout/stderr drain; `exit` can precede the last chunk.
      child.once('close', code => { clearTimeout(timeout); done({ code, output }); });
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Retained export requires --retained-engine DIR or IFCLITE_RETAINED_ENGINE');
    expect(result.output).not.toMatch(/Local:\s+http/);
    await record('missing-engine', result);
  });
});

// #7955 release scope item 4: real authoring-tool exports, and model/entity identity
// where the retained kernel meets the federation registry. Retained geometry is one
// model at a time by design (M2 §2.1): a federated add is refused in BOTH directions,
// so these tests assert that refusal leaves the open model's identity intact, that a
// Retry builds a correct exact federation, and that a retained primary load replaces
// a federation completely.
const ARCHICAD = 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc';
const SKETCHUP = 'apps/viewer/public/samples/building-architecture.ifc';
const BONSAI = 'apps/viewer/public/samples/hello-wall.ifc';
const REAL_MODELS = [
  { tool: 'ArchiCAD', file: ARCHICAD, header: /ARCHICAD-64/ },
  { tool: 'Bonsai', file: BONSAI, header: /Bonsai/ },
];
const baseName = (path: string) => path.split('/').at(-1)!;
const SDK_REQUEST = /\/smlib\/|pkg-retained|\/retained-engine\//;

/** Per model: which meshes resolve to it, and whether its data store agrees about their types. */
async function identities(page: Page) {
  return page.evaluate(() => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    return [...state.models.values()].map(model => {
      const entities = model.ifcDataStore?.entities;
      const meshes = model.geometryResult?.meshes ?? [];
      const locals = new Set<number>(), foreign: number[] = [], unresolved: number[] = [], typeMismatch: number[] = [];
      for (const mesh of meshes) {
        const hit = state.resolveGlobalIdFromModels(mesh.expressId);
        if (!hit) { unresolved.push(mesh.expressId); continue; }
        if (hit.modelId !== model.id) { foreign.push(mesh.expressId); continue; }
        locals.add(hit.expressId);
        const type = entities?.getTypeName(hit.expressId);
        if (mesh.ifcType && type && mesh.ifcType.toLowerCase() !== type.toLowerCase()) typeMismatch.push(hit.expressId);
      }
      const sorted = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);
      return { id: model.id, name: model.name, idOffset: model.idOffset, maxExpressId: model.maxExpressId, loadState: model.loadState,
        summary: model.retainedGeometry, locals: sorted(locals), globals: sorted(meshes.map(mesh => mesh.expressId)),
        foreign, unresolved, typeMismatch,
        refusedKnown: (model.retainedGeometry?.refused ?? []).every(row => Boolean(entities?.getTypeName(row.expressId))) };
    });
  });
}
type Identity = Awaited<ReturnType<typeof identities>>[number];
/** What must not move when a refused load leaves a model open. */
const stable = ({ id, name, idOffset, maxExpressId, locals, globals }: Identity) => ({ id, name, idOffset, maxExpressId, locals, globals });

async function completeModels(page: Page, names: string[], retained: boolean) {
  try {
    await page.waitForFunction(({ names, retained }) => {
      const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
      const models = [...state.models.values()];
      // Same settle rule as the other multi-model specs: an exact model's loadState is not the signal.
      return !state.loading && !state.geometryStreamingActive && models.length === names.length && names.every(name => {
        const model = models.find(candidate => candidate.name === name);
        return model && model.loadState !== 'error' && (model.geometryResult?.meshes.length ?? 0) + (model.retainedGeometry?.refused.length ?? 0) > 0
          && (!retained || (model.retainedGeometry && model.retainedGeometry.completeness !== 'running'));
      });
    }, { names, retained }, { timeout: 90_000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const store = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
      return { loading: store.loading, streaming: store.geometryStreamingActive, error: store.error,
        models: [...store.models.values()].map(m => ({ name: m.name, loadState: m.loadState, meshes: m.geometryResult?.meshes.length ?? null,
          completeness: m.retainedGeometry?.completeness })) };
    });
    throw new Error(`models ${JSON.stringify(names)} did not settle: ${JSON.stringify(state)}`, { cause: error });
  }
}
async function chooseRetained(page: Page) {
  await page.evaluate(() => {
    sessionStorage.setItem('ifc-lite:geometry-kernel', 'retained');
    history.replaceState(null, '', '/?kernel=retained&perfTrace=1');
  });
}
/** Select through the canonical global id; useModelSelection derives the model-aware ref. */
async function selectGlobal(page: Page, globalId: number, expectedRef: { modelId: string; expressId: number }) {
  await page.evaluate(id => (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState().setSelectedEntityId(id), globalId);
  await page.waitForFunction(({ globalId, expectedRef }) => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    return state.selectedEntityId === globalId && state.selectedEntity?.modelId === expectedRef.modelId
      && state.selectedEntity?.expressId === expectedRef.expressId;
  }, { globalId, expectedRef });
}
const selection = (page: Page) => page.evaluate(() => {
  const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
  return { global: state.selectedEntityId, ref: state.selectedEntity };
});
function expectCleanIdentity(model: Identity, published: number[]) {
  expect(model.foreign).toEqual([]);
  expect(model.unresolved).toEqual([]);
  expect(model.typeMismatch).toEqual([]);
  expect(model.locals).toEqual(published);
}

test.describe('retained viewer: real authoring-tool exports and federation identity', () => {
  test.beforeEach(({}, testInfo) => {
    if (engine && existsSync(join(engine, 'engine-manifest.json'))) return;
    // The lane that requires the SDK sets IFCLITE_REQUIRE_SMLIB: there a missing engine is a failure, never a skip.
    if (process.env.IFCLITE_REQUIRE_SMLIB && testInfo.project.name === 'viewer-retained') throw new Error('IFCLITE_RETAINED_ENGINE must name a staged engine; a skip is not evidence');
    test.skip(true, SKIP);
  });

  for (const { tool, file, header } of REAL_MODELS) {
    test(`a real ${tool} export keeps model, entity and refusal identity under the retained kernel`, async ({ page }) => {
      expect(readFileSync(file, 'latin1').slice(0, 60000)).toMatch(header);
      const requests: string[] = [], workers: string[] = [];
      page.context().on('request', req => requests.push(req.url()));
      page.on('worker', worker => workers.push(worker.url()));
      await setup(page, 'retained');
      await page.locator('#file-input-open').setInputFiles(resolve(file));
      await completeModels(page, [baseName(file)], true);
      const rows = expected(file), published = rows.filter(p => p.status === 'published').map(p => p.id);
      const refused = rows.filter(p => p.status === 'refused');
      expect(rows.length).toBeGreaterThan(0);
      const [model, ...others] = await identities(page);
      expect(others).toEqual([]);
      expect((await snapshot(page)).error).toBeNull();
      // One model: the registry's single-model fallback, globalId === expressId.
      expect(model.idOffset).toBe(0);
      expect(model.globals).toEqual(model.locals);
      expectCleanIdentity(model, published);
      expect(model.summary?.candidates).toBe(rows.length);
      expect(model.summary?.published).toBe(published.length);
      expect(model.summary?.refused.map(p => ({ id: p.expressId, code: p.code })).sort((a, b) => a.id - b.id))
        .toEqual(refused.map(({ id, code }) => ({ id, code })));
      expect(model.refusedKnown, 'a refused product keeps its entity data').toBe(true);
      for (const row of model.summary!.refused) expect(model.locals).not.toContain(row.expressId);
      expect(workers.some(url => /retained\.worker/.test(url)), 'the retained host runs in a real browser Worker').toBe(true);
      expect(requests.some(url => url.includes('/smlib/'))).toBe(true);

      // Panel: one row per refused product, with its own code.
      const chip = page.locator('[data-retained-chip="incomplete"]');
      await expect(chip).toContainText(`${published.length}/${rows.length}`);
      await chip.click();
      await expect(page.locator('[data-retained-row]')).toHaveCount(refused.length);
      for (const row of refused) await expect(page.locator(`[data-retained-row="${row.id}"]`)).toHaveAttribute('data-code', row.code);

      // Selection resolves to this model and the product's own express id.
      await selectGlobal(page, published[0], { modelId: model.id, expressId: published[0] });
      await selectGlobal(page, published.at(-1)!, { modelId: model.id, expressId: published.at(-1)! });
      await page.getByRole('button', { name: `Select #${refused[0].id}`, exact: true }).click();
      expect(await selection(page)).toMatchObject({ ref: { modelId: model.id, expressId: refused[0].id } });
      await record(`real-${tool.toLowerCase()}`, { file, tool, rows: rows.length, published: published.length, refused: refused.length, model: stable(model) });
    });
  }

  test('a real SketchUp export refused product by product loads as an incomplete, mesh-free model with its identity intact', async ({ page }) => {
    expect(readFileSync(SKETCHUP, 'latin1').slice(0, 60000)).toMatch(/IFC manager for sketchup/i);
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(SKETCHUP));
    await page.waitForFunction(() => {
      const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      return !state.loading && model?.retainedGeometry && model.retainedGeometry.completeness !== 'running';
    });
    const rows = expected(SKETCHUP);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.status === 'refused'), 'the manifest pins every SketchUp product as refused').toBe(true);
    const [model, ...others] = await identities(page);
    expect(others).toEqual([]);
    expect((await snapshot(page)).error).toBeNull();
    expect(model.idOffset).toBe(0);
    expect(model.globals).toEqual([]);
    expect(model.summary?.published).toBe(0);
    expect(model.summary?.completeness).toBe('incomplete');
    expect(model.summary?.refused.map(p => ({ id: p.expressId, code: p.code })).sort((a, b) => a.id - b.id))
      .toEqual(rows.map(({ id, code }) => ({ id, code })));
    expect(model.refusedKnown, 'refused products keep their entity data').toBe(true);
    await page.locator('[data-retained-chip="incomplete"]').click();
    await expect(page.locator('[data-retained-row]')).toHaveCount(rows.length);
    await page.getByRole('button', { name: `Select #${rows[0].id}`, exact: true }).click();
    expect(await selection(page)).toMatchObject({ ref: { modelId: model.id, expressId: rows[0].id } });
    await record('real-sketchup', { model: stable(model), refused: rows.length });
  });

  test('a refused retained federated add leaves the exact primary intact; Retry builds a correct federation with colliding ids', async ({ page }) => {
    const requests: string[] = [];
    page.context().on('request', req => requests.push(req.url()));
    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
    await completeModels(page, [baseName(MAPPED)], false);
    const [first] = await identities(page);
    expectCleanIdentity(first, first.locals);
    expect(first.locals.length).toBeGreaterThan(1);
    await selectGlobal(page, first.locals[0], { modelId: first.id, expressId: first.locals[0] });

    await chooseRetained(page);
    await page.locator('#file-input-add').setInputFiles(resolve(WALL));
    await expect.poll(async () => (await snapshot(page)).error).toMatch(/Retained geometry loads one model at a time/);
    const afterRefusal = await identities(page);
    expect(afterRefusal.map(stable)).toEqual([stable(first)]);
    expect((await selection(page)).ref).toMatchObject({ modelId: first.id, expressId: first.locals[0] });
    expect(requests.filter(url => SDK_REQUEST.test(url))).toEqual([]);

    // Retry switches the next load to exact and federates; a copy collides on every express id.
    await page.getByRole('button', { name: /^retry/i }).click();
    await completeModels(page, [baseName(MAPPED), baseName(WALL)], false);
    await page.locator('#file-input-add').setInputFiles({ name: 'mapped-copy.ifc', mimeType: 'application/octet-stream', buffer: readFileSync(MAPPED) });
    const names = [baseName(MAPPED), baseName(WALL), 'mapped-copy.ifc'];
    await completeModels(page, names, false);
    const models = await identities(page);
    const byName = (name: string) => models.find(model => model.name === name)!;
    const [a, b, c] = names.map(byName);
    expect(models).toHaveLength(3);
    expect(stable(a)).toEqual(stable(first));
    expect(c.locals, 'the copy uses the very same express ids').toEqual(a.locals);
    for (const model of models) { expect(model.foreign).toEqual([]); expect(model.unresolved).toEqual([]); expect(model.typeMismatch).toEqual([]); }
    expect(models.map(model => model.idOffset)).toEqual([...models.map(model => model.idOffset)].sort((x, y) => x - y));
    expect(new Set(models.map(model => model.idOffset)).size).toBe(3);
    expect(new Set(models.flatMap(model => model.globals)).size, 'global ids never collide').toBe(models.flatMap(model => model.globals).length);
    // The same local id selects a different model depending on its global id.
    const local = a.locals[0];
    const globalIn = (model: Identity) => model.globals[model.locals.indexOf(local)];
    await selectGlobal(page, globalIn(a), { modelId: a.id, expressId: local });
    await selectGlobal(page, globalIn(c), { modelId: c.id, expressId: local });
    await selectGlobal(page, b.globals[0], { modelId: b.id, expressId: b.locals[0] });
    expect(requests.filter(url => SDK_REQUEST.test(url))).toEqual([]);
    await record('federation-retry', { first: stable(first), models: models.map(stable) });
  });

  test('a retained primary load replaces an exact federation completely', async ({ page }) => {
    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
    await completeModels(page, [baseName(MAPPED)], false);
    await page.locator('#file-input-add').setInputFiles({ name: 'mapped-copy.ifc', mimeType: 'application/octet-stream', buffer: readFileSync(MAPPED) });
    await completeModels(page, [baseName(MAPPED), 'mapped-copy.ifc'], false);
    const [, copy] = await identities(page);
    expect(copy.idOffset).toBeGreaterThan(0);
    await selectGlobal(page, copy.globals[0], { modelId: copy.id, expressId: copy.locals[0] });

    await chooseRetained(page);
    await page.locator('#file-input-open').setInputFiles(resolve(WALL));
    await completeModels(page, [baseName(WALL)], true);
    const rows = expected(WALL), published = rows.filter(p => p.status === 'published').map(p => p.id);
    const models = await identities(page);
    expect(models).toHaveLength(1);
    const [model] = models;
    expect(model.idOffset, 'a primary load restarts the id space').toBe(0);
    expect(model.globals).toEqual(model.locals);
    expectCleanIdentity(model, published);
    expect(model.summary?.refused.map(p => p.expressId).sort((a, b) => a - b)).toEqual(rows.filter(p => p.status === 'refused').map(p => p.id));
    const { ref } = await selection(page);
    expect(ref === null || ref.modelId === model.id, 'no selection survives into a model that replaced its model').toBe(true);
    await selectGlobal(page, published[0], { modelId: model.id, expressId: published[0] });
    await record('federation-replaced', { model: stable(model) });
  });

  test('an exact add onto an open retained model is refused with identity, selection and refusal rows intact', async ({ page }) => {
    const requests: string[] = [];
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(WALL));
    await completeModels(page, [baseName(WALL)], true);
    const [before] = await identities(page);
    const published = before.locals, refusedId = before.summary!.refused[0].expressId;
    await selectGlobal(page, published[0], { modelId: before.id, expressId: published[0] });
    page.context().on('request', req => requests.push(req.url()));

    await page.locator('#file-input-add').setInputFiles(resolve(MAPPED));
    await expect.poll(async () => (await snapshot(page)).error).toMatch(/Reload it with the exact kernel/);
    const retry = await page.evaluate(() => (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState().lastLoadRetry);
    expect(retry, 'no Retry: an exact add would mix kernels in one view').toBeNull();
    const [after, ...others] = await identities(page);
    expect(others).toEqual([]);
    expect(stable(after)).toEqual(stable(before));
    expect(after.summary).toEqual(before.summary);
    expect((await selection(page)).ref).toMatchObject({ modelId: before.id, expressId: published[0] });
    expect(requests.filter(url => SDK_REQUEST.test(url)), 'a refused add starts no retained work').toEqual([]);
    // The refusal rows are still this model's.
    await page.locator('[data-retained-chip]').click();
    await expect(page.locator(`[data-retained-row="${refusedId}"]`)).toHaveAttribute('data-code', before.summary!.refused[0].code);
    await record('federation-reverse-add', { before: stable(before), after: stable(after), refusedId });
  });

  test('a second retained primary load replaces the first: no stale rows, meshes or selection', async ({ page }) => {
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(resolve(WALL));
    await completeModels(page, [baseName(WALL)], true);
    const [first] = await identities(page);
    await selectGlobal(page, first.locals[0], { modelId: first.id, expressId: first.locals[0] });

    // Bonsai, not the mapped fixture: retained instancing (M11-I) publishes that model as instance shards, not meshes.
    await page.locator('#file-input-open').setInputFiles(resolve(BONSAI));
    await completeModels(page, [baseName(BONSAI)], true);
    const rows = expected(BONSAI), published = rows.filter(p => p.status === 'published').map(p => p.id);
    const models = await identities(page);
    expect(models).toHaveLength(1);
    const [second] = models;
    expect(second.name).toBe(baseName(BONSAI));
    expect(second.idOffset).toBe(0);
    expectCleanIdentity(second, published);
    expect(second.summary?.candidates).toBe(rows.length);
    expect(second.summary?.refused.map(p => p.expressId).sort((a, b) => a - b)).toEqual(rows.filter(p => p.status === 'refused').map(p => p.id));
    expect(second.globals, 'no mesh of the first model remains').toEqual(second.locals);
    const { ref } = await selection(page);
    expect(ref === null || ref.modelId === second.id).toBe(true);
    await page.locator('[data-retained-chip]').click();
    await expect(page.locator('[data-retained-row]')).toHaveCount(second.summary!.refused.length);
    await record('primary-replaced', { first: stable(first), second: stable(second) });
  });
});

test('build without a kernel choice loads exact without retained assets', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'viewer-retained-default' && !(engine && existsSync(join(engine, 'engine-manifest.json'))), SKIP);
  const requests: string[] = [], workers: string[] = [];
  page.context().on('request', req => requests.push(req.url()));
  page.on('worker', worker => workers.push(worker.url()));
  await setup(page);
  await page.locator('#file-input-open').setInputFiles(resolve(MAPPED));
  await complete(page, false);
  const result = await snapshot(page);
  expect(result.meshIds.length).toBeGreaterThan(0);
  expect(result.summary).toBeUndefined();
  expect(requests.filter(url => /\/smlib\/|pkg-retained|\/retained-engine\//.test(url))).toEqual([]);
  expect(workers.filter(url => /retained|smlib/.test(url))).toEqual([]);
  await expect(page.locator('[data-retained-chip]')).toHaveCount(0);
  await record('default', result);
});
