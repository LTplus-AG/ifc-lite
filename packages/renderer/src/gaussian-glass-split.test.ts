/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 nearest-glass split (option B): recorder, depth-only variants, layer count,
// frame schedule and reporting, against recording fakes. Pixels are covered by the
// browser witness (examples/gaussian-splat-spike/contract, scene nearestGlassSplit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DeferredPassRecorder } from './gaussian/gaussian-pass-recorder.js';
import { GaussianGlassSplit, glassDepthShader } from './gaussian/gaussian-glass-split.js';
import { GaussianGlassComposer } from './gaussian/gaussian-glass-frame.js';
import { compositionReport } from './gaussian/gaussian-composition.js';
import { gaussianReadiness } from './gaussian/gaussian-readiness.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { ghostShaderSource } from './shaders/ghost.wgsl.js';
import { depthNudgeWgsl } from './shaders/depth-nudge.wgsl.js';
import type { GaussianBackendScene, GaussianDepthInterval, GaussianEncodeTarget } from './gaussian/gaussian-backend.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
(globalThis as Record<string, unknown>).GPUMapMode ??= { READ: 1 };

type Log = unknown[][];
const pipeline = (label: string) => ({ label }) as unknown as GPURenderPipeline;
const GLASS = pipeline('glass'), GHOST = pipeline('ghost'), SELECTION = pipeline('selection'), OPAQUE = pipeline('opaque');

/** A pass that logs every call with its arguments. */
function loggingPass(log: Log, label = 'pass'): GPURenderPassEncoder {
  return new Proxy({}, { get: (_t, key) => (...args: unknown[]) => { log.push([label, key, ...args]); } }) as GPURenderPassEncoder;
}

/** Draw one glass group (two pipelines) and a highlight into `pass`, as renderFrame does. */
function drawGroup(pass: GPURenderPassEncoder): void {
  pass.setPipeline(OPAQUE); // the pipeline current before the group, recorded first by renderFrame
  pass.setPipeline(GLASS);
  pass.setBindGroup(0, 'g0' as never);
  pass.drawIndexed(3);
  pass.setPipeline(GHOST);
  pass.drawIndexed(6, 2, 0, 0, 1);
}

test('#8564 the recorder holds the transparent group and the highlight, and replays both verbatim', () => {
  const recorder = new DeferredPassRecorder(null, () => null);
  assert.equal(recorder.begin(true), true);
  drawGroup(recorder.pass);
  recorder.markGlassEnd();
  recorder.pass.setPipeline(SELECTION);
  recorder.pass.drawIndexed(9);
  const main: Log = [];
  recorder.end(loggingPass(main, 'main'));
  assert.deepEqual(main, [], 'a ready split keeps the group out of the main pass');
  assert.equal(recorder.deferred, true);
  assert.deepEqual([...recorder.glassPipelines], [GLASS, GHOST], 'only pipelines that drew glass; never the highlight or the pipeline current before the group');
  assert.equal(recorder.highlightDraws, 1);

  const colour: Log = [];
  recorder.replay(loggingPass(colour), { initial: [[1, 'env' as never], [3, 'sections' as never]] });
  assert.deepEqual(colour.map((c) => c.slice(1)), [
    ['setBindGroup', 1, 'env'], ['setBindGroup', 3, 'sections'],
    ['setPipeline', GLASS], ['setBindGroup', 0, 'g0'], ['drawIndexed', 3],
    ['setPipeline', GHOST], ['drawIndexed', 6, 2, 0, 0, 1], ['setPipeline', SELECTION], ['drawIndexed', 9],
  ]);

  const depth: Log = [];
  const variant = (p: GPURenderPipeline) => pipeline(`depth:${(p as unknown as { label: string }).label}`);
  recorder.replay(loggingPass(depth), { depthOnly: variant });
  assert.deepEqual(depth.map((c) => c[1] === 'setPipeline' ? (c[2] as { label: string }).label : c[1]), [
    'depth:glass', 'setBindGroup', 'drawIndexed', 'depth:ghost', 'drawIndexed',
  ], 'the depth-only replay maps every glass pipeline and stops before the highlight');
});

test('#8564 a group the split cannot use goes back into the main pass in order, with the reason', () => {
  for (const [why, prepare, extra] of [
    ['pipelines-compiling', () => 'pipelines-compiling' as const, null],
    ['unsupported-draw', () => null, 'executeBundles'],
  ] as const) {
    const recorder = new DeferredPassRecorder(null, prepare);
    recorder.begin(true);
    drawGroup(recorder.pass);
    if (extra) (recorder.pass as unknown as Record<string, (...a: unknown[]) => void>)[extra]('bundles');
    const main: Log = [];
    recorder.end(loggingPass(main, 'main'));
    assert.equal(recorder.deferred, false, why);
    assert.equal(recorder.fallback, why);
    assert.equal(recorder.transparent, true);
    const expected = [['setPipeline', GLASS], ['setBindGroup', 0, 'g0'], ['drawIndexed', 3], ['setPipeline', GHOST], ['drawIndexed', 6, 2, 0, 0, 1]];
    if (extra) expected.push([extra, 'bundles']);
    assert.deepEqual(main.map((c) => c.slice(1)), expected, `${why}: the main pass receives the identical command stream`);
  }
});

test('#8564 a disabled split never holds the group but still reports that the frame had transparent IFC', () => {
  const recorder = new DeferredPassRecorder('single-pass-mode', () => { throw new Error('never prepared'); });
  assert.equal(recorder.begin(true), false);
  assert.equal(recorder.transparent, true);
  assert.equal(recorder.fallback, 'single-pass-mode');
  const empty = new DeferredPassRecorder(null, () => null);
  assert.equal(empty.begin(false), false);
  assert.equal(empty.transparent, false);
  assert.equal(empty.fallback, null);
  // A group whose transparent draws all dropped out (e.g. RTE packing) is not a transparent frame.
  const dropped = new DeferredPassRecorder(null, () => { throw new Error('nothing to prepare'); });
  dropped.begin(true);
  dropped.pass.setPipeline(GLASS);
  dropped.markGlassEnd();
  dropped.pass.setPipeline(SELECTION);
  dropped.pass.drawIndexed(3);
  const main: Log = [];
  dropped.end(loggingPass(main));
  assert.equal(dropped.transparent, false);
  assert.equal(dropped.deferred, false);
  assert.deepEqual(main.map((c) => c.slice(1)), [['setPipeline', SELECTION], ['drawIndexed', 3]], 'the highlight still draws, in the main pass');
});

test('#8564 the depth-only shader keeps the base fragment (and its discards) and the depth nudge, without colour', () => {
  for (const source of [mainShaderSource, ghostShaderSource]) {
    const out = glassDepthShader(source);
    assert.ok(out.includes(depthNudgeWgsl), 'the vertex depth matches the drawn glass, nudge included');
    assert.match(out, /@fragment fn fs_glass_depth\(input: VertexOutput\) \{ _ = fs_main\(input\); \}/);
    assert.doesNotMatch(out, /@fragment\s*fn fs_main\(/, 'fs_main is a plain function now');
    assert.equal(out.split('fn fs_main(input: VertexOutput)').length, 2);
    assert.equal(out.length, source.length - '@fragment'.length + out.slice(out.lastIndexOf('\n@fragment fn fs_glass_depth')).length);
  }
  assert.throws(() => glassDepthShader('fn other() {}'), /no '@fragment fn fs_main/);
  assert.throws(() => glassDepthShader('@fragment\nfn x() {}\nfn fs_main(input: VertexOutput) {}'), /no '@fragment fn fs_main/);
});

test('#8564 composition reports: no transparent, the split, and every fallback', () => {
  assert.deepEqual(compositionReport({ transparent: false, split: false, highlight: true, later: true, fallback: null }, 'multiple'),
    { composition: 'no-transparent', fallback: null, transparentLayers: null, highlightOverSplats: false, laterOverBehindSplats: false });
  assert.deepEqual(compositionReport({ transparent: true, split: true, highlight: true, later: true, fallback: null }, 'multiple'),
    { composition: 'nearest-glass-split', fallback: null, transparentLayers: 'multiple', highlightOverSplats: true, laterOverBehindSplats: true });
  assert.deepEqual(compositionReport({ transparent: true, split: false, highlight: true, later: true, fallback: 'pipelines-compiling' }, 'single'),
    { composition: 'over-transparent-approximate', fallback: 'pipelines-compiling', transparentLayers: null, highlightOverSplats: false, laterOverBehindSplats: false });
});

test('#8564 readiness keeps the published blocker tuple and adds the nearest-glass-split capability', () => {
  const readiness = gaussianReadiness(true, false, false, 1, 'available');
  assert.equal(readiness.state, 'blocked');
  assert.ok(readiness.state === 'blocked');
  assert.deepEqual([...readiness.reasons], ['exact-mixed-transparency', 'scalable-global-order', 'native-viewer-contract']);
  assert.ok(readiness.capabilities?.includes('nearest-glass-split'));
});

/** A device that records pipeline descriptors, passes and readbacks. */
function fakeDevice(options: { failCompile?: boolean; count?: bigint; deferMaps?: boolean } = {}) {
  const log: Log = [];
  const descriptors: GPURenderPipelineDescriptor[] = [];
  const counts = new BigUint64Array([options.count ?? 0n]), read = counts.buffer;
  const parked: Array<() => void> = [];
  let mapped = 0;
  const device = {
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createRenderPipelineAsync: async (d: GPURenderPipelineDescriptor) => {
      descriptors.push(d);
      if (options.failCompile) throw new Error('compile failed');
      return pipeline(d.label ?? 'variant');
    },
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => pipeline(d.label ?? 'quad'),
    createTexture: (d: GPUTextureDescriptor) => ({ ...d, createView: () => ({ of: d.label }), destroy: () => log.push(['destroy', d.label]) }),
    createQuerySet: (d: GPUQuerySetDescriptor) => ({ ...d, destroy() {} }),
    createBuffer: (d: GPUBufferDescriptor) => ({
      ...d, destroy() {}, unmap() {}, getMappedRange: () => read,
      mapAsync: () => { mapped++; return options.deferMaps ? new Promise<void>((resolve) => parked.push(resolve)) : Promise.resolve(); },
    }),
  } as unknown as GPUDevice;
  const encoder = {
    beginRenderPass: (d: GPURenderPassDescriptor) => { log.push(['begin', d]); return loggingPass(log, d.label ?? ''); },
    resolveQuerySet: (...a: unknown[]) => log.push(['resolveQuerySet', ...a]),
    copyBufferToBuffer: (...a: unknown[]) => log.push(['copyBufferToBuffer', ...a]),
  } as unknown as GPUCommandEncoder;
  /** Complete the oldest pending readback with `count` samples beyond one layer. */
  const resolveMap = async (count: bigint) => { counts[0] = count; parked.shift()!(); await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { device, encoder, log, descriptors, mapped: () => mapped, resolveMap, pendingMaps: () => parked.length };
}

const registration = (label: string): { descriptor: GPURenderPipelineDescriptor; source: string } => ({
  source: mainShaderSource,
  descriptor: {
    label, layout: 'layout' as never, vertex: { module: {} as GPUShaderModule, entryPoint: 'vs_main' },
    fragment: { module: {} as GPUShaderModule, entryPoint: 'fs_main', targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
    depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'greater' },
    multisample: { count: 4 },
  },
});

const recorded = () => {
  const recorder = new DeferredPassRecorder(null, () => null);
  recorder.begin(true);
  drawGroup(recorder.pass);
  return recorder;
};
const frame = (encoder: GPUCommandEncoder) => ({ encoder, depthView: 'main-depth' as never, depthFormat: 'depth24plus-stencil8' as GPUTextureFormat, sampleCount: 4, width: 8, height: 6, initial: [] });

test('#8564 depth-only variants share the base vertex stage and layout; P1 is depth32float nearest-wins, the count increments stencil', async () => {
  const fake = fakeDevice();
  let ready = 0;
  const split = new GaussianGlassSplit(fake.device, () => { ready++; });
  const describe = (p: GPURenderPipeline) => p === GLASS ? registration('glass') : p === GHOST ? registration('ghost') : undefined;
  assert.equal(split.prepare(new Set([GLASS, GHOST]), describe), 'pipelines-compiling');
  assert.equal(split.prepare(new Set([OPAQUE]), describe), 'unsupported-draw', 'an unregistered pipeline cannot be replayed depth-only');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ready, 2);
  assert.equal(split.prepare(new Set([GLASS, GHOST]), describe), null);
  const nearest = fake.descriptors.find((d) => d.label === 'ifc-lite-gaussian-nearest-transparent')!;
  const count = fake.descriptors.find((d) => d.label === 'ifc-lite-gaussian-transparent-count')!;
  for (const d of [nearest, count]) {
    assert.equal(d.layout, 'layout');
    assert.equal(d.vertex.entryPoint, 'vs_main');
    assert.equal(d.vertex.module, d.fragment!.module, 'one transformed module for both stages');
    assert.equal(d.fragment!.entryPoint, 'fs_glass_depth');
    assert.deepEqual(d.fragment!.targets, []);
    assert.equal(d.multisample!.count, 4);
  }
  assert.deepEqual(nearest.depthStencil, { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' });
  assert.equal(count.depthStencil!.format, 'depth24plus-stencil8');
  assert.equal(count.depthStencil!.depthWriteEnabled, false);
  assert.equal(count.depthStencil!.depthCompare, 'greater', 'only transparent surfaces in front of opaque depth count');
  assert.equal(count.depthStencil!.stencilFront!.passOp, 'increment-clamp');
  assert.equal(count.depthStencil!.stencilBack!.passOp, 'increment-clamp');
});

test('#8564 P1 clears to the far plane; two or more surfaces at any sample report multiple layers once read back', async () => {
  for (const [samples, expected] of [[0n, 'single'], [7n, 'multiple']] as const) {
    const fake = fakeDevice({ count: samples });
    const split = new GaussianGlassSplit(fake.device, () => {});
    const describe = () => registration('glass');
    split.prepare(new Set([GLASS, GHOST]), describe);
    await new Promise((resolve) => setTimeout(resolve, 0));
    split.beginFrame();
    const texture = split.encodeNearest(frame(fake.encoder), recorded()) as unknown as GPUTextureDescriptor;
    assert.equal(texture.format, 'depth32float');
    assert.equal(texture.sampleCount, 4);
    const passes = fake.log.filter((c) => c[0] === 'begin').map((c) => c[1] as GPURenderPassDescriptor);
    assert.deepEqual(passes.map((p) => p.label), ['ifc-lite-gaussian-nearest-transparent', 'ifc-lite-gaussian-transparent-layers']);
    assert.deepEqual(passes[0].colorAttachments, []);
    assert.equal(passes[0].depthStencilAttachment!.depthClearValue, 0);
    assert.equal(passes[0].depthStencilAttachment!.depthLoadOp, 'clear');
    assert.equal(passes[1].depthStencilAttachment!.view, 'main-depth');
    assert.equal(passes[1].depthStencilAttachment!.depthReadOnly, true);
    assert.equal(passes[1].depthStencilAttachment!.stencilLoadOp, 'clear');
    const countPass = fake.log.filter((c) => c[0] === 'ifc-lite-gaussian-transparent-layers').map((c) => c[1]);
    assert.deepEqual(countPass.slice(-6), ['setPipeline', 'setStencilReference', 'beginOcclusionQuery', 'draw', 'endOcclusionQuery', 'end']);
    assert.equal(fake.log.find((c) => c[1] === 'setStencilReference')![2], 2);
    assert.equal(split.layers, 'unknown');
    split.submitted();
    split.submitted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fake.mapped(), 1, 'one readback per frame');
    assert.equal(split.layers, expected);
    assert.equal(split.layerSamples, Number(samples));
    split.beginFrame();
    assert.equal(split.layers, 'unknown', 'a new frame starts unknown');
    assert.equal(split.layerSamples, null);
  }
});

test('#8564 a variant that fails to compile makes its frames fall back, permanently and visibly', async () => {
  const fake = fakeDevice({ failCompile: true });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const split = new GaussianGlassSplit(fake.device, () => {});
    assert.equal(split.prepare(new Set([GLASS]), () => registration('glass')), 'pipelines-compiling');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(split.prepare(new Set([GLASS]), () => registration('glass')), 'unsupported-draw');
    assert.equal(errors.length, 1);
  } finally { console.error = original; }
});

class SceneLog implements GaussianBackendScene {
  gpuBytes = 0;
  constructor(private readonly log: Log) {}
  async replaceSource() {}
  updateRows() {}
  setFilter() {}
  destroy() {}
  encode(target: GaussianEncodeTarget, _camera: unknown, interval?: GaussianDepthInterval) {
    this.log.push(['splats', interval?.compare ?? 'all', target.resolveTarget ?? null]);
  }
}

test('#8564 frame schedule: P1, splats behind, the held transparent IFC and highlight, splats in front with the resolve', async () => {
  const fake = fakeDevice();
  const composer = new GaussianGlassComposer(() => {});
  const visibility = {
    describe: () => registration('glass'),
    resume: (encoder: GPUCommandEncoder, d: GPURenderPassDescriptor) => encoder.beginRenderPass(d),
  };
  const target = { encoder: fake.encoder, colorView: 'msaa' as never, resolveTarget: 'swapchain' as never, depthView: 'main-depth' as never,
    colorFormat: 'bgra8unorm' as GPUTextureFormat, depthFormat: 'depth24plus-stencil8' as GPUTextureFormat, sampleCount: 4, width: 8, height: 6 };
  const camera = { modelViewProjection: new Float64Array(16), cameraPosition: [0, 0, 0] as [number, number, number] };
  const scene = new SceneLog(fake.log);
  const run = () => {
    const recorder = composer.recorder(fake.device, true, visibility);
    recorder.begin(true);
    drawGroup(recorder.pass);
    recorder.markGlassEnd();
    recorder.pass.setPipeline(SELECTION);
    recorder.pass.drawIndexed(9);
    recorder.end(loggingPass(fake.log, 'main'));
    return recorder;
  };
  const first = run();
  assert.equal(first.deferred, false, 'the first frame waits for the variants');
  composer.encode(scene, target, camera, { recorder: first, visibility });
  assert.equal(composer.report.fallback, 'pipelines-compiling');
  assert.equal(composer.report.composition, 'over-transparent-approximate');
  assert.deepEqual(fake.log.filter((c) => c[0] === 'splats'), [['splats', 'all', 'swapchain']]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  fake.log.length = 0;

  const second = run();
  assert.equal(second.deferred, true);
  composer.encode(scene, target, camera, { recorder: second, visibility, objectIdView: 'ids' as never, objectIdStore: 'store', initialBindGroups: [[1, 'env' as never]] });
  const order = fake.log.filter((c) => c[0] === 'begin' || c[0] === 'splats').map((c) => c[0] === 'begin' ? (c[1] as GPURenderPassDescriptor).label : `splats:${c[1]}`);
  assert.deepEqual(order, ['ifc-lite-gaussian-nearest-transparent', 'ifc-lite-gaussian-transparent-layers', 'splats:less-equal', 'ifc-lite-gaussian-transparent', 'splats:greater']);
  assert.equal(fake.log.find((c) => c[0] === 'splats' && c[1] === 'less-equal')![2], null, 'splats behind the glass do not resolve');
  assert.equal(fake.log.find((c) => c[0] === 'splats' && c[1] === 'greater')![2], 'swapchain', 'splats in front resolve MSAA');
  const glassPass = fake.log.find((c) => c[0] === 'begin' && (c[1] as GPURenderPassDescriptor).label === 'ifc-lite-gaussian-transparent')![1] as GPURenderPassDescriptor;
  assert.deepEqual(glassPass.colorAttachments, [{ view: 'msaa', loadOp: 'load', storeOp: 'store' }, { view: 'ids', loadOp: 'load', storeOp: 'store' }]);
  assert.deepEqual(glassPass.depthStencilAttachment, { view: 'main-depth', depthLoadOp: 'load', depthStoreOp: 'store', stencilLoadOp: 'load', stencilStoreOp: 'discard' });
  const glassCalls = fake.log.filter((c) => c[0] === 'ifc-lite-gaussian-transparent').map((c) => c.slice(1));
  assert.deepEqual(glassCalls.slice(0, 2), [['setBindGroup', 1, 'env'], ['setPipeline', GLASS]], 'a pipeline set without a draw (the main pass\'s current one) is dropped');
  assert.deepEqual(glassCalls.at(-2), ['drawIndexed', 9], 'the highlight follows the glass, as in the single-pass frame');
  assert.equal(composer.report.composition, 'nearest-glass-split');
  assert.equal(composer.report.highlightOverSplats, true);
  assert.equal(composer.report.transparentLayers, 'unknown', 'until the count reads back');
  composer.submitted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(composer.report.transparentLayers, 'single', 'the frame\'s own count is published when it reads back, without another frame');
  fake.log.length = 0;
  composer.encode(scene, target, camera, { recorder: run(), visibility });
  assert.equal(composer.report.transparentLayers, 'unknown', 'a new frame never inherits an earlier count');

  // A frame without splats to draw still draws the held group, and resolves in that pass.
  fake.log.length = 0;
  composer.encode(null, target, null, { recorder: run(), visibility });
  const only = fake.log.filter((c) => c[0] === 'begin').map((c) => c[1] as GPURenderPassDescriptor);
  assert.deepEqual(only.map((p) => p.label), ['ifc-lite-gaussian-transparent']);
  assert.deepEqual((only[0].colorAttachments as GPURenderPassColorAttachment[])[0], { view: 'msaa', loadOp: 'load', resolveTarget: 'swapchain', storeOp: 'discard' });

  // No transparent IFC: the single pass, unchanged.
  fake.log.length = 0;
  const none = composer.recorder(fake.device, true, visibility);
  none.begin(false);
  composer.encode(scene, target, camera, { recorder: none, visibility });
  assert.deepEqual(fake.log.filter((c) => c[0] === 'begin' || c[0] === 'splats'), [['splats', 'all', 'swapchain']]);
  assert.equal(composer.report.composition, 'no-transparent');
});

test('#8564 composition mode and upstream capability gate the split', () => {
  const fake = fakeDevice();
  const composer = new GaussianGlassComposer(() => {});
  const visibility = { describe: () => undefined, resume: () => { throw new Error('unused'); } };
  const missing = composer.recorder(fake.device, false, visibility);
  assert.equal(missing.begin(true), false);
  assert.equal(missing.fallback, 'upstream-interval-missing');
  composer.setMode('single-pass');
  const single = composer.recorder(fake.device, true, visibility);
  assert.equal(single.begin(true), false);
  assert.equal(single.fallback, 'single-pass-mode');
  assert.throws(() => composer.setMode('exact' as never), /Unknown Gaussian composition mode/);
});

/** A composer whose depth-only variants are compiled, on a device whose readbacks wait for `resolveMap`. */
async function readyComposer(options: { failCompile?: boolean } = {}) {
  const fake = fakeDevice({ deferMaps: true, ...options });
  let renders = 0;
  const composer = new GaussianGlassComposer(() => { renders++; });
  const visibility = { describe: () => registration('glass'), resume: (encoder: GPUCommandEncoder, d: GPURenderPassDescriptor) => encoder.beginRenderPass(d) };
  const target = { encoder: fake.encoder, colorView: 'msaa' as never, resolveTarget: 'swapchain' as never, depthView: 'main-depth' as never,
    colorFormat: 'bgra8unorm' as GPUTextureFormat, depthFormat: 'depth24plus-stencil8' as GPUTextureFormat, sampleCount: 4, width: 8, height: 6 };
  const camera = { modelViewProjection: new Float64Array(16), cameraPosition: [0, 0, 0] as [number, number, number] };
  const recorderFor = (transparent = true) => {
    const recorder = composer.recorder(fake.device, true, visibility);
    if (recorder.begin(transparent)) drawGroup(recorder.pass);
    recorder.end(loggingPass(fake.log, 'main'));
    return recorder;
  };
  recorderFor(); // the first frame starts compiling the variants
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { fake, composer, visibility, target, camera, recorderFor, renders: () => renders };
}

test('#8564 review F1: a layer count describes only the frame that issued it (camera moves while its query is pending)', async () => {
  const { fake, composer, visibility, target, camera, recorderFor, renders } = await readyComposer();
  const scene = new SceneLog(fake.log);
  composer.encode(scene, target, camera, { recorder: recorderFor(), visibility }); // frame A: one pane
  composer.submitted();
  assert.equal(fake.pendingMaps(), 1);
  assert.equal(composer.report.transparentLayers, 'unknown');
  composer.encode(scene, target, camera, { recorder: recorderFor(), visibility }); // frame B: camera moved, A still reading
  composer.submitted();
  assert.equal(fake.pendingMaps(), 1, 'B could not issue its own count while A was reading');
  const before = renders();
  await fake.resolveMap(0n); // A answers "single": stale for B
  assert.equal(composer.report.transparentLayers, 'unknown', 'B never claims A\'s single layer');
  assert.equal(renders(), before + 1, 'B has no count of its own, so a render is requested');
  composer.encode(scene, target, camera, { recorder: recorderFor(), visibility }); // frame C, same view as B
  composer.submitted();
  await fake.resolveMap(5n);
  assert.equal(composer.report.transparentLayers, 'multiple', 'C\'s own count is published when it arrives, with no further frame');
});

test('#8564 review F1: a pending count never overwrites a later non-split frame', async () => {
  const { fake, composer, visibility, target, camera, recorderFor } = await readyComposer();
  const scene = new SceneLog(fake.log);
  composer.encode(scene, target, camera, { recorder: recorderFor(), visibility }); // split frame A
  composer.submitted();
  composer.encode(scene, target, camera, { recorder: recorderFor(false), visibility }); // no transparent IFC
  assert.equal(composer.report.composition, 'no-transparent');
  await fake.resolveMap(0n);
  assert.deepEqual(composer.report, compositionReport({ transparent: false, split: false, highlight: false, later: false, fallback: null }, 'unknown'));
  composer.encode(scene, target, camera, { recorder: recorderFor(), visibility }); // split frame C, own count pending
  assert.equal(composer.report.composition, 'nearest-glass-split');
  assert.equal(composer.report.transparentLayers, 'unknown', 'A\'s late result was dropped, not kept for C');
  composer.submitted();
  await fake.resolveMap(0n);
  assert.equal(composer.report.transparentLayers, 'single', 'C\'s own count is published');
  composer.encode(scene, target, camera, { recorder: recorderFor(), visibility }); // split frame D
  assert.equal(composer.report.transparentLayers, 'unknown', 'D starts unknown: a published count never carries over');
});

class FailingScene extends SceneLog {
  constructor(log: Log, private readonly failing: GaussianDepthInterval['compare']) { super(log); }
  override encode(target: GaussianEncodeTarget, camera: unknown, interval?: GaussianDepthInterval) {
    if (interval?.compare === this.failing) throw new Error(`injected ${this.failing} failure`);
    super.encode(target, camera, interval);
  }
}

test('#8564 review F4: a failed behind-glass encode draws every splat once after the glass and reports split-failed', async () => {
  const { fake, composer, visibility, target, camera, recorderFor } = await readyComposer();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    fake.log.length = 0;
    assert.equal(composer.encode(new FailingScene(fake.log, 'less-equal'), target, camera, { recorder: recorderFor(), visibility }), false);
    const order = fake.log.filter((c) => c[0] === 'begin' || c[0] === 'splats').map((c) => c[0] === 'begin' ? (c[1] as GPURenderPassDescriptor).label : `splats:${c[1]}:${c[2]}`);
    assert.deepEqual(order.slice(-2), ['ifc-lite-gaussian-transparent', 'splats:all:swapchain'], 'the held glass, then one unfiltered splat pass that resolves');
    assert.equal(fake.log.filter((c) => c[0] === 'splats').length, 1, 'every splat is drawn exactly once');
    assert.equal(composer.report.composition, 'over-transparent-approximate');
    assert.equal(composer.report.fallback, 'split-failed');
    assert.equal(errors.length, 1);
    // A failure in front of the glass is reported the same way.
    assert.equal(composer.encode(new FailingScene(fake.log, 'greater'), target, camera, { recorder: recorderFor(), visibility }), false);
    assert.equal(composer.report.fallback, 'split-failed');
  } finally { console.error = original; }
});
