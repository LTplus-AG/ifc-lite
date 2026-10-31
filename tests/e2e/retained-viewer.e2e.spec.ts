// SPDX-License-Identifier: MPL-2.0
// #7955 M2-D: real built viewer, real host Worker and real staged SDK.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
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
const expected = (model: string) => readFileSync('tests/manifests/cli-retained-coverage.tsv', 'utf8')
  .split(/\r?\n/).map(line => line.split('\t')).filter(row => row[0] === model)
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

// ---- #7955 item 4: authored metallic/roughness parity and viewer export, in memory so no fixture file changes ----
/** The pixel scene with two authored specular finishes, hand-derived from IfcSurfaceStyleRendering's attributes and the
 * documented join rule (rust/processing/src/style/finish_join.rs: a finish comes from an ITEM-level style or the
 * element's own product-shape style; a material-chain style is colour-only), never read back from the code under test:
 * #29 (item style) SpecularHighlight = IfcSpecularRoughness(0.125) wins and ReflectanceMethod METAL gives metallic 1;
 * #39 takes its colour from a material-defined style whose SpecularColour 0.75 would give roughness 0.25 if the join
 * read it, and it must not: no finish at all, in either kernel. */
const FINISHES: Record<number, { metallic?: number; roughness: number }> = { 29: { metallic: 1, roughness: 0.125 } };
function finishPixel(): string {
  const source = readFileSync(PIXEL, 'utf8');
  const metal = '#21=IFCSURFACESTYLERENDERING(#20,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULARROUGHNESS(0.125),.METAL.);';
  const matte = '#42=IFCSURFACESTYLERENDERING(#41,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);';
  const finished = source.replace('#21=IFCSURFACESTYLERENDERING(#20,0.,$,$,$,$,$,$,.NOTDEFINED.);', metal)
    .replace('#42=IFCSURFACESTYLERENDERING(#41,0.,$,$,$,$,$,$,.NOTDEFINED.);', matte);
  expect(finished.includes(metal) && finished.includes(matte), 'both authored finishes are in the fixture').toBe(true);
  return finished;
}
/** `finishPixel()` plus a third product the retained kernel refuses (an image texture, `appearance_unsupported` by user
 * ruling) and the exact engine meshes: the product that tells an export of retained geometry from a re-mesh of the file. */
const TEXTURED_ID = 1028;
function finishPixelWithTexture(): string {
  const texture = [
    '#1016=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));',
    '#1017=IFCTRIANGULATEDFACESET(#1016,$,.T.,((1,3,2),(1,2,4),(1,4,3),(2,3,4)),$);',
    "#1018=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'checker.png');",
    '#1019=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(1.,1.)));',
    '#1020=IFCINDEXEDTRIANGLETEXTUREMAP((#1018),#1017,#1019,((2,1,4),(2,4,3),(2,3,1),(4,1,3)));',
    '#1021=IFCCOLOURRGB($,1.,1.,1.);', '#1022=IFCSURFACESTYLESHADING(#1021,0.);', '#1023=IFCSURFACESTYLEWITHTEXTURES((#1018));',
    "#1024=IFCSURFACESTYLE('SYNTHETIC',.BOTH.,(#1022,#1023));", '#1025=IFCSTYLEDITEM(#1017,(#1024),$);',
    "#1026=IFCSHAPEREPRESENTATION(#4,'Body','Tessellation',(#1017));", '#1027=IFCPRODUCTDEFINITIONSHAPE($,$,(#1026));',
    "#1028=IFCBUILDINGELEMENTPROXY('3M$UnHTcrSNe_nAyqDWrRK',$,'image-tetrahedron',$,$,#9,#1027,$,.NOTDEFINED.);",
    "#1029=IFCRELCONTAINEDINSPATIALSTRUCTURE('0IJRzxlLzRFeHqx65H1CtX',$,$,$,(#1028),#12);",
  ].join('\n') + '\n';
  const source = finishPixel();
  const grafted = source.replace('ENDSEC;\nEND-ISO', `${texture}ENDSEC;\nEND-ISO`);
  expect(grafted, 'the fixture ends with a single DATA section').not.toBe(source);
  return grafted;
}
/** `finishPixel()` with #29's square profile a circle: the kernels tessellate a circle differently, so a GLB's
 * triangle count identifies the geometry it was built from. */
function cylinderPixel(): string {
  const source = finishPixel();
  const cylinder = source.replace('#18=IFCRECTANGLEPROFILEDEF(.AREA.,$,#17,2.,2.);', '#18=IFCCIRCLEPROFILEDEF(.AREA.,$,#17,1.);');
  expect(cylinder, 'the first product has a circular profile').not.toBe(source);
  return cylinder;
}
const asFile = (name: string, text: string) => ({ name, mimeType: 'application/ifc', buffer: Buffer.from(text) });
/** The glTF JSON chunk of a GLB. */
function glbJson(glb: Buffer): { meshes?: unknown[]; accessors?: { count: number }[] } {
  expect(glb.readUInt32LE(0), 'glTF magic').toBe(0x46546c67);
  const length = glb.readUInt32LE(12);
  expect(glb.readUInt32LE(16), 'first chunk is JSON').toBe(0x4e4f534a);
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8'));
}
/** One mesh node of a GLB with its vertices in glTF world space (node transforms composed, one entry per triangle
 * corner), and the material's linear base colour. Only what the instanced-export check compares. */
interface GlbNode { expressId?: number; corners: number[][]; rgba: number[] }
function glbWorldNodes(glb: Buffer): GlbNode[] {
  type Json = { scenes: { nodes: number[] }[]; scene?: number; nodes: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[];
    rotation?: number[]; scale?: number[]; extras?: { expressId?: number } }[]; meshes: { primitives: { attributes: { POSITION: number }; indices?: number; material?: number }[] }[];
    accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[]; materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[] } }[] };
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Json;
  const binStart = 20 + jsonLength;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
  const read = (index: number): number[][] => {
    const a = json.accessors[index], view = json.bufferViews[a.bufferView];
    const width = { SCALAR: 1, VEC3: 3 }[a.type]!, size = { 5126: 4, 5125: 4, 5123: 2, 5122: 2, 5121: 1, 5120: 1 }[a.componentType]!;
    const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = view.byteStride ?? width * size;
    const norm = { 5123: 65535, 5122: 32767, 5121: 255, 5120: 127 }[a.componentType];
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, c) => {
      const at = base + i * stride + c * size;
      const v = a.componentType === 5126 ? bin.readFloatLE(at) : a.componentType === 5125 ? bin.readUInt32LE(at) : a.componentType === 5123 ? bin.readUInt16LE(at)
        : a.componentType === 5122 ? bin.readInt16LE(at) : a.componentType === 5121 ? bin.readUInt8(at) : bin.readInt8(at);
      return a.normalized && norm ? v / norm : v;
    }));
  };
  // Column-major 4x4.
  const mul = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, i) => { const col = Math.floor(i / 4), row = i % 4;
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[col * 4 + k], 0); });
  const local = (n: Json['nodes'][number]): number[] => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const out: GlbNode[] = [];
  const visit = (index: number, parent: number[]) => {
    const node = json.nodes[index], world = mul(parent, local(node));
    if (node.mesh !== undefined) for (const primitive of json.meshes[node.mesh].primitives) {
      const positions = read(primitive.attributes.POSITION).map(([x, y, z]) => [0, 1, 2].map(r => world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r]));
      const indices = primitive.indices === undefined ? positions.map((_, i) => i) : read(primitive.indices).map(([i]) => i);
      out.push({ expressId: node.extras?.expressId, corners: indices.map(i => positions[i]),
        rgba: json.materials?.[primitive.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor ?? [] });
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of json.scenes[json.scene ?? 0].nodes) visit(root, identity);
  return out;
}
const centroid = (corners: number[][]) => [0, 1, 2].map(a => corners.reduce((sum, c) => sum + c[a], 0) / corners.length);
const extents = (corners: number[][]) => [0, 1, 2].map(a => Math.max(...corners.map(c => c[a])) - Math.min(...corners.map(c => c[a]))).sort((a, b) => a - b);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Open a ribbon export dialog the way a user does, and return it. */
async function openExport(page: Page, id: string) {
  // The privacy toast sits over the dialog's footer until dismissed.
  for (const dismiss of await page.getByRole('button', { name: 'Dismiss notification' }).all()) await dismiss.click();
  await page.getByRole('tab', { name: 'File', exact: true }).click();
  await page.locator(`[data-export-command="${id}"]`).click();
  const dialog = page.locator('[data-export-dialog-shell]');
  await expect(dialog).toBeVisible();
  return dialog;
}
/** Press Export in an open dialog and return the downloaded bytes. */
async function download(page: Page, button: string | RegExp): Promise<{ name: string; bytes: Buffer }> {
  const dialog = page.locator('[data-export-dialog-shell]');
  // The privacy toast can arrive after the dialog opened and then covers its footer.
  for (const dismiss of await page.getByRole('button', { name: 'Dismiss notification' }).all()) await dismiss.click();
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), dialog.getByRole('button', { name: button, exact: typeof button === 'string' }).click()]);
  const path = await file.path();
  expect(path, 'the downloaded file exists').toBeTruthy();
  return { name: file.suggestedFilename(), bytes: readFileSync(path!) };
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

  // M11-A follow-up (#7955 item 4): the same authored metallic/roughness through both kernels. The oracle is the IFC
  // attribute semantics written in `FINISHES`; neither kernel's own output is the reference for the other.
  const storedMaterials = (page: Page) => page.evaluate(() => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return (model?.geometryResult?.meshes ?? []).map(m => ({ id: state.resolveGlobalIdFromModels(m.expressId)?.expressId as number,
      metallic: m.material?.metallic, roughness: m.material?.roughness }));
  });
  test('M11-A: retained and exact carry the same authored metallic/roughness on flat products, and no finish from a material style', async ({ page }) => {
    const observed: Record<string, { id: number; metallic?: number; roughness?: number }[]> = {};
    for (const kernel of ['exact', 'retained'] as const) {
      await setup(page, kernel);
      await page.locator('#file-input-open').setInputFiles(asFile('finish-pixel.ifc', finishPixel()));
      await complete(page, kernel === 'retained');
      const result = await snapshot(page);
      expect(result.error, `${kernel} load`).toBeNull();
      if (kernel === 'retained') expect(result.summary?.refused).toEqual([]);
      observed[kernel] = (await storedMaterials(page)).sort((a, b) => a.id - b.id);
      expect(observed[kernel].map(m => m.id), `${kernel} products`).toEqual([29, 39]);
      for (const mesh of observed[kernel]) {
        expect({ metallic: mesh.metallic, roughness: mesh.roughness }, `${kernel} #${mesh.id}`)
          .toEqual(FINISHES[mesh.id] ?? { metallic: undefined, roughness: undefined });
      }
    }
    expect(observed.retained, 'retained and exact agree product by product').toEqual(observed.exact);
    await record('finish-flat', observed);
  });

  test('M11-A x M11-I: every instanced occurrence carries its own authored metallic/roughness in both kernels', async ({ page }) => {
    // Even occurrences: metal with roughness 0.125; odd: SpecularColour 0.75 -> roughness 0.25, no metal evidence.
    const source = readFileSync(MAPPED, 'utf8');
    const styles = '#20001=IFCCOLOURRGB($,0.9,0.1,0.1);#20002=IFCSURFACESTYLERENDERING(#20001,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULARROUGHNESS(0.125),.METAL.);'
      + '#20003=IFCSURFACESTYLE($,.BOTH.,(#20002));#20004=IFCCOLOURRGB($,0.1,0.1,0.9);'
      + '#20005=IFCSURFACESTYLERENDERING(#20004,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);#20006=IFCSURFACESTYLE($,.BOTH.,(#20005));\n'
      + Array.from({ length: 64 }, (_, i) => `#${20010 + i}=IFCSTYLEDITEM(#${25 + 7 * i},(#${i % 2 === 0 ? 20003 : 20006}),$);`).join('\n') + '\n';
    const styled = source.replace('ENDSEC;\nEND-ISO', `${styles}ENDSEC;\nEND-ISO`);
    expect(styled, 'the fixture ends with a single DATA section').not.toBe(source);
    const seen: Record<string, { shard: number; flat: number; materials: Record<number, { metallic?: number; roughness?: number }> }> = {};
    for (const kernel of ['exact', 'retained'] as const) {
      await setup(page, kernel);
      await page.evaluate(() => {
        const globals = globalThis as typeof globalThis & ViewerGlobals & { __m11Finish?: Record<number, { metallic?: number; roughness?: number }>; __m11Shards?: number };
        const done = new Set<ArrayBuffer>();
        globals.__m11Finish = {}; globals.__m11Shards = 0;
        globals.__ifc_lite_viewer_store__.subscribe(state => {
          for (const { bytes } of state.pendingInstancedShards ?? []) {
            if (done.has(bytes)) continue;
            done.add(bytes);
            globals.__m11Shards!++;
            const wire = new DataView(bytes), templates = wire.getUint32(8, true), instances = wire.getUint32(12, true);
            const stride = wire.getUint32(4, true) >= 2 ? wire.getUint32(28, true) || 88 : 88;
            for (let i = 0; i < instances; i++) {
              const record = 32 + templates * 48 + i * stride;
              // Trailing field 2 (stride >= 100): metallic, roughness at +92, +96; NaN where unauthored.
              const metallic = stride >= 100 ? wire.getFloat32(record + 92, true) : NaN, roughness = stride >= 100 ? wire.getFloat32(record + 96, true) : NaN;
              globals.__m11Finish![wire.getUint32(record + 4, true)] = {
                ...(Number.isFinite(metallic) ? { metallic } : {}), ...(Number.isFinite(roughness) ? { roughness } : {}) };
            }
          }
        });
      });
      await page.locator('#file-input-open').setInputFiles(asFile('mapped-finishes.ifc', styled));
      await complete(page, kernel === 'retained');
      const result = await snapshot(page);
      expect(result.error, `${kernel} load`).toBeNull();
      const { shards, shard, flat } = await page.evaluate(() => {
        const globals = globalThis as typeof globalThis & ViewerGlobals & { __m11Finish: Record<number, { metallic?: number; roughness?: number }>; __m11Shards: number };
        const state = globals.__ifc_lite_viewer_store__.getState();
        const model = [...state.models.values()][0];
        const flatMaterials: Record<number, { metallic?: number; roughness?: number }> = {};
        for (const m of model?.geometryResult?.meshes ?? []) {
          const id = state.resolveGlobalIdFromModels(m.expressId)?.expressId as number;
          flatMaterials[id] = { ...(m.material?.metallic !== undefined ? { metallic: m.material.metallic } : {}),
            ...(m.material?.roughness !== undefined ? { roughness: m.material.roughness } : {}) };
        }
        return { shards: globals.__m11Shards, shard: globals.__m11Finish, flat: flatMaterials };
      });
      // A product is carried by a shard or by a flat mesh; either way it must carry the finish it was authored with.
      const materials = { ...flat, ...shard };
      seen[kernel] = { shard: Object.keys(shard).length, flat: Object.keys(flat).length, materials };
      for (let i = 0; i < 64; i++) {
        const id = 31 + 7 * i;
        const authoredFinish = i % 2 === 0 ? { metallic: 1, roughness: 0.125 } : { roughness: 0.25 };
        expect(materials[id], `${kernel} occurrence #${id} carries a finish (${shards} shards)`).toBeDefined();
        expect(materials[id].roughness, `${kernel} #${id} roughness`).toBeCloseTo(authoredFinish.roughness, 6);
        expect(materials[id].metallic, `${kernel} #${id} metallic`).toBe(authoredFinish.metallic);
      }
    }
    expect(seen.retained.shard, 'the retained run instanced these occurrences').toBeGreaterThan(0);
    await record('finish-instanced', { exactShardOccurrences: seen.exact.shard, exactFlat: seen.exact.flat,
      retainedShardOccurrences: seen.retained.shard, retainedFlat: seen.retained.flat });
  });

  // Viewer-side export (#7955 item 4c). A complete retained model exports what the viewer holds, never the exact
  // engine's re-mesh of its file; USD and the energy models can only re-mesh the file, so they are refused (disabled with
  // a reason) on any retained model; an incomplete one keeps the existing shape-only refusal of mesh exports.
  const glbTriangles = (glb: Buffer) => {
    const json = glbJson(glb);
    return (json.meshes as { primitives: { indices?: number }[] }[] ?? [])
      .flatMap(mesh => mesh.primitives).reduce((sum, primitive) => sum + (primitive.indices === undefined ? 0 : json.accessors![primitive.indices].count / 3), 0);
  };
  const heldTriangles = (page: Page) => page.evaluate(() => {
    const state = (globalThis as typeof globalThis & ViewerGlobals).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    return (model?.geometryResult?.meshes ?? []).reduce((sum, m) => sum + m.indices.length / 3, 0);
  });
  test('export: a complete retained model\'s GLB is the geometry the viewer holds, not the exact re-mesh of its file', async ({ page }) => {
    const text = cylinderPixel();
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(asFile('cylinder-pixel.ifc', text));
    await complete(page, true);
    const loaded = await snapshot(page);
    expect(loaded.error).toBeNull();
    expect(loaded.summary?.refused, 'complete: nothing refused').toEqual([]);
    const retainedHeld = await heldTriangles(page);
    await openExport(page, 'glb');
    const retained = await download(page, 'Export');
    const retainedGlb = glbTriangles(retained.bytes);

    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(asFile('cylinder-pixel.ifc', text));
    await complete(page, false);
    await openExport(page, 'glb');
    const exactGlb = glbTriangles((await download(page, 'Export')).bytes);

    // The two kernels mesh the cylinder differently, so the GLB's triangle count says which geometry it was built from.
    expect(retainedHeld, 'the kernels differ on this fixture (else the check below could not tell them apart)').not.toBe(exactGlb);
    expect(retainedGlb, 'the retained GLB is exactly the geometry the viewer holds').toBe(retainedHeld);
    await record('export-glb', { retainedHeld, retainedGlb, exactGlb });
  });

  test('export: a retained model\'s GLB carries every instanced occurrence as the viewport holds it', async ({ page }) => {
    await setup(page, 'retained');
    await page.evaluate(() => {
      const globals = globalThis as typeof globalThis & ViewerGlobals & { __expColours?: Record<number, number[]> };
      const seen = new Set<ArrayBuffer>();
      globals.__expColours = {};
      globals.__ifc_lite_viewer_store__.subscribe(state => {
        for (const { bytes } of state.pendingInstancedShards ?? []) {
          if (seen.has(bytes)) continue;
          seen.add(bytes);
          const wire = new DataView(bytes), templates = wire.getUint32(8, true), instances = wire.getUint32(12, true);
          const stride = wire.getUint32(4, true) >= 2 ? wire.getUint32(28, true) || 88 : 88;
          for (let i = 0; i < instances; i++) {
            const record = 32 + templates * 48 + i * stride;
            globals.__expColours![wire.getUint32(record + 4, true)] = [0, 4, 8, 12].map(offset => wire.getFloat32(record + 8 + offset, true));
          }
        }
      });
    });
    const source = readFileSync(MAPPED, 'utf8');
    const styles = '#20001=IFCCOLOURRGB($,0.9,0.1,0.1);#20002=IFCSURFACESTYLERENDERING(#20001,0.,$,$,$,$,$,$,.NOTDEFINED.);'
      + '#20003=IFCSURFACESTYLE($,.BOTH.,(#20002));#20004=IFCCOLOURRGB($,0.1,0.1,0.9);'
      + '#20005=IFCSURFACESTYLERENDERING(#20004,0.,$,$,$,$,$,$,.NOTDEFINED.);#20006=IFCSURFACESTYLE($,.BOTH.,(#20005));\n'
      + Array.from({ length: 64 }, (_, i) => `#${20010 + i}=IFCSTYLEDITEM(#${25 + 7 * i},(#${i % 2 === 0 ? 20003 : 20006}),$);`).join('\n') + '\n';
    const styled = source.replace('ENDSEC;\nEND-ISO', `${styles}ENDSEC;\nEND-ISO`);
    expect(styled, 'the fixture ends with a single DATA section').not.toBe(source);
    await page.locator('#file-input-open').setInputFiles(asFile('mapped-two-colours.ifc', styled));
    await complete(page, true);
    const loaded = await snapshot(page);
    expect(loaded.summary?.published).toBe(64);
    expect(loaded.summary?.refused).toEqual([]);
    expect(await heldTriangles(page), 'every occurrence lives in an instanced shard, none in the flat meshes').toBe(0);
    await rendererHooks(page);
    const ids = Array.from({ length: 64 }, (_, i) => 31 + 7 * i);
    const held = await page.evaluate(ids => {
      const globals = globalThis as typeof globalThis & ViewerGlobals & { __expColours: Record<number, number[]> };
      return ids.map(id => ({ id, owner: globals.__ifc_lite_scene_owner__!(id), colour: globals.__expColours[id] }));
    }, ids);
    for (const { id, owner, colour } of held) {
      expect(owner.instance, `#${id} is drawn as a GPU instance`).toBe(true);
      expect(colour, `#${id} has a shard colour`).toBeDefined();
    }
    await openExport(page, 'glb');
    const glb = await download(page, 'Export');
    const nodes = glbWorldNodes(glb.bytes);
    expect(nodes, 'one mesh node per instanced occurrence').toHaveLength(64);
    const byId = new Map(nodes.map(node => [node.expressId, node]));
    expect([...byId.keys()].sort((a, b) => (a ?? 0) - (b ?? 0)), 'every occurrence id is a node').toEqual(ids);
    const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const heldCorners = (id: number) => { const flat = held.find(h => h.id === id)!.owner.corners; return Array.from({ length: flat.length / 3 }, (_, i) => flat.slice(i * 3, i * 3 + 3)); };
    const heldFirst = centroid(heldCorners(ids[0])), glbFirst = centroid(byId.get(ids[0])!.corners);
    let worst = 0;
    for (const id of ids) {
      const node = byId.get(id)!, mine = heldCorners(id);
      expect(node.corners.length, `#${id} triangle corners`).toBe(mine.length);
      extents(node.corners).forEach((e, k) => expect(Math.abs(e - extents(mine)[k]), `#${id} extent ${k} (metres)`).toBeLessThan(1e-4));
      // Positions up to the one rigid frame change between the viewport and the GLB root: the offset of each occurrence from the first.
      // Both snapshots are Y-up metres. The GLB root restores the render-frame translation;
      // compare signed offsets too, so a reflected or swapped occurrence matrix cannot pass.
      const glbCentre = centroid(node.corners), heldCentre = centroid(mine);
      [0, 1, 2].forEach(axis => expect(Math.abs((glbCentre[axis] - glbFirst[axis])
        - (heldCentre[axis] - heldFirst[axis])), `#${id} signed position axis ${axis}`).toBeLessThan(1e-3));
      const gap = Math.abs(distance(glbCentre, glbFirst) - distance(heldCentre, heldFirst));
      worst = Math.max(worst, gap);
      expect(gap, `#${id} offset from #${ids[0]}`).toBeLessThan(1e-3);
      const colour = held.find(h => h.id === id)!.colour;
      [0, 1, 2].forEach(c => expect(Math.abs(node.rgba[c] - srgbToLinear(colour[c])), `#${id} colour channel ${c}`).toBeLessThan(1e-4));
    }
    await record('export-glb-instanced', { nodes: nodes.length, meshesInGlb: (glbJson(glb.bytes).meshes ?? []).length, worstOffsetGap: worst });
  });

  test('export: USD, Cesium ion and the energy models are refused on a retained model, GLB and IFC5 only while it is incomplete', async ({ page }) => {
    const command = (id: string) => page.locator(`[data-export-command="${id}"]`);
    const states = async () => Object.fromEntries(await Promise.all(['glb', 'kmz', 'ion', 'usd', 'energy', 'ifc', 'json'].map(async id =>
      [id, await command(id).isDisabled()] as const)));
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(asFile('finish-pixel.ifc', finishPixel()));
    await complete(page, true);
    await page.getByRole('tab', { name: 'File', exact: true }).click();
    const complete_ = await states();
    expect(complete_, 'complete retained model').toEqual({ glb: false, kmz: false, ion: true, usd: true, energy: true, ifc: false, json: false });

    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(asFile('finish-texture.ifc', finishPixelWithTexture()));
    await complete(page, true);
    expect((await snapshot(page)).summary?.refused.map(r => r.expressId)).toEqual([TEXTURED_ID]);
    await page.getByRole('tab', { name: 'File', exact: true }).click();
    const incomplete = await states();
    expect(incomplete, 'incomplete retained model').toEqual({ glb: true, kmz: true, ion: true, usd: true, energy: true, ifc: false, json: false });

    // Control: the exact kernel keeps every one of them, and USD exports.
    await setup(page, 'exact');
    await page.locator('#file-input-open').setInputFiles(asFile('finish-texture.ifc', finishPixelWithTexture()));
    await complete(page, false);
    await page.getByRole('tab', { name: 'File', exact: true }).click();
    const exact = await states();
    expect(exact, 'exact model').toEqual({ glb: false, kmz: false, ion: false, usd: false, energy: false, ifc: false, json: false });
    await openExport(page, 'usd');
    const usd = await download(page, /^Export$/);
    expect(usd.bytes.subarray(0, 5).toString('utf8'), 'the exact control exports a USD stage').toBe('#usda');
    await record('export-availability', { complete: complete_, incomplete, exact, exactUsdBytes: usd.bytes.length });
  });

  test('export: the formats that need no geometry kernel still export from a retained model (IFC, JSON)', async ({ page }) => {
    await setup(page, 'retained');
    await page.locator('#file-input-open').setInputFiles(asFile('finish-pixel.ifc', finishPixel()));
    await complete(page, true);
    await openExport(page, 'ifc');
    const ifc = await download(page, /^Export$/);
    expect(ifc.bytes.subarray(0, 13).toString('utf8')).toBe('ISO-10303-21;');
    expect(ifc.bytes.toString('utf8')).toContain('IFCSPECULARROUGHNESS');
    await page.keyboard.press('Escape');
    const [json] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.locator('[data-export-command="json"]').click()]);
    const parsed = JSON.parse(readFileSync((await json.path())!, 'utf8'));
    expect(JSON.stringify(parsed)).toContain('pixel-red');
    await record('export-data-formats', { ifcBytes: ifc.bytes.length, json: json.suggestedFilename() });
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
