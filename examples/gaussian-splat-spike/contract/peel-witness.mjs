/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// K-layer back-to-front glass peeling composed with upstream Gaussian splats (#8564).
// mode=reference: per pixel (1x) or per sample (4x, pipeline sample masks), scissored
// draws in the independently computed far-to-near order; upstream shader unmodified.
// mode=candidate: opaque, K peel passes, a K+1 occlusion-query exhaustion pass and
// one composite pass of interval-filtered upstream splat draws + glass layers.
import { WebGPUDevice } from '@luma.gl/webgpu';
import { makeGPUSplatData, SplatRenderer } from '@luma.gl/splats';
import { MathUtils } from '../../../packages/renderer/src/math.ts';
import { normalizeGaussianAttributes } from '../../../packages/renderer/src/gaussian/gaussian-attributes.ts';
import { buildScene, cameraMatrix, FAR, NEAR, SAMPLE_POSITIONS, sampleReference, splatColumns } from './peel-scene.mjs';
import { ALPHA_OVER, checkedModule, checkedPipeline, readRGBA8, sceneShader, toBase64, unpackSamples } from './peel-gpu.mjs';
import { probeSampleShading } from './peel-probe.mjs';

const query = new URLSearchParams(location.search);
const config = {
  mode: query.get('mode') ?? 'candidate', samples: Number(query.get('samples') ?? 1), layers: Number(query.get('layers') ?? 4),
  schedule: query.get('schedule') ?? 'peel', peelRate: query.get('peelRate') ?? 'sample',
  sampleDepth: query.get('sampleDepth') ?? 'varying', // 4x per-sample depth source: varying | position
  glassOrder: query.get('glassOrder') ?? 'submission', // 'reversed': negative control for coincident glass
  sizes: (query.get('sizes') ?? '24,32,48').split(',').map(Number),
  panes: (query.get('panes') ?? 'all').split(','),
  // nearest (#8564 option B): splitDisabled draws every splat after the glass (negative control).
  splitDisabled: query.get('split') === 'off',
};
const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING, CS = GPUTextureUsage.COPY_SRC;
const LAYER_DEPTH_TOLERANCE = 2 ** -20;

function cameraFor(projection) {
  const m = projection === 'orthographic' ? MathUtils.orthographicReverseZ(-1, 1, -1, 1, NEAR, FAR).m
    : MathUtils.perspectiveReverseZ(Math.PI / 3, 1, NEAR, FAR).m;
  const expected = cameraMatrix(projection);
  if (m.some((value, i) => value !== expected[i])) throw new Error(`IFC-Lite ${projection} camera diverged from the peel scene`);
  return m;
}

/** Per-frame resources and pipelines shared by both modes. */
async function frameSetup(ctx, scene, multisampled) {
  const { raw, device, errors } = ctx, { size } = scene, samples = config.samples, owned = [];
  const own = resource => { owned.push(resource); return resource; };
  const texture = (format, sampleCount, usage) => own(raw.createTexture({ size: [size, size], format, sampleCount, usage }));
  const lumaTextures = new Map();
  const luma = handle => {
    if (!lumaTextures.has(handle)) lumaTextures.set(handle, own(device.createTexture({ handle, width: size, height: size, format: handle.format, samples: handle.sampleCount, usage: handle.usage })));
    return lumaTextures.get(handle);
  };
  const color = texture('rgba8unorm', samples, RA | TB | CS), opaqueDepth = texture('depth32float', samples, RA | TB);
  const module = await checkedModule(raw, sceneShader(scene, { multisampled, sampleDepth: config.sampleDepth }), `scene-${scene.projection}-${size}`, errors);
  const depth = (depthCompare, depthWriteEnabled) => ({ format: 'depth32float', depthCompare, depthWriteEnabled });
  const opaque = await checkedPipeline(raw, { label: 'opaque', vertex: { module, entryPoint: 'vsOpaque' }, multisample: { count: samples },
    fragment: { module, entryPoint: 'fsOpaque', targets: [{ format: 'rgba8unorm' }] }, depthStencil: depth('greater', true) }, errors);
  const renderer = data => own(new SplatRenderer(device, { data, viewportSize: [size, size], modelViewProjectionMatrix: scene.camera,
    depthCompare: 'greater', depthConvention: 'reverse', sphericalHarmonicsDegree: 0, toneMapping: 'none' }));
  const splatData = splats => own(makeGPUSplatData(device, normalizeGaussianAttributes(splatColumns(splats))));
  const encoder = raw.createCommandEncoder(), wrapped = own(device.createCommandEncoder({ handle: encoder }));
  const opaquePass = () => {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: { view: opaqueDepth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 } });
    pass.setPipeline(opaque); pass.draw(6); pass.end();
  };
  // Composite/reference pass: opaque depth is a read-only attachment that may also be sampled.
  const compositePass = async draw => {
    const native = encoder.beginRenderPass({ colorAttachments: [{ view: color.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: opaqueDepth.createView(), depthReadOnly: true } });
    const framebuffer = own(device.createFramebuffer({ width: size, height: size, colorAttachments: [luma(color)], depthStencilAttachment: luma(opaqueDepth) }));
    const pass = device.beginRenderPass({ handle: native, framebuffer });
    try { draw(native, pass); pass.end(); } finally { pass.destroy(); }
    raw.queue.submit([encoder.finish()]);
    await raw.queue.onSubmittedWorkDone();
  };
  const readColor = async () => samples === 1 ? readRGBA8(raw, color, size, size) : unpackSamples(raw, color, { kind: 'color', samples, size }, errors);
  return { owned, own, texture, luma, color, opaqueDepth, module, depth, renderer, splatData, encoder, wrapped, opaquePass, compositePass, readColor };
}

async function referenceFrame(ctx, scene) {
  const { raw, errors } = ctx, { size } = scene, samples = config.samples;
  const setup = await frameSetup(ctx, scene, false);
  try {
    const masks = samples > 1 ? [0xf, ...SAMPLE_POSITIONS[samples].map((_, s) => 1 << s)] : [0xffffffff];
    const glass = await Promise.all(masks.map(mask => checkedPipeline(raw, { label: `reference-glass-${mask}`, multisample: { count: samples, mask },
      vertex: { module: setup.module, entryPoint: 'vsGlass' }, depthStencil: setup.depth('always', false),
      fragment: { module: setup.module, entryPoint: 'fsGlass', targets: [{ format: 'rgba8unorm', blend: ALPHA_OVER }] } }, errors)));
    // Glass draws use no depth test: the analytic per-sample order already omits everything behind
    // opaque. One unmodified upstream renderer per Gaussian and sample mask; no interval binding exists.
    const renderers = scene.splats.map(splat => {
      const data = setup.splatData([splat]);
      return masks.map(mask => {
        const renderer = setup.renderer(data);
        if (samples > 1) renderer.model.setParameters({ ...renderer.model.parameters, sampleCount: samples, sampleMask: mask });
        return renderer;
      });
    });
    setup.opaquePass();
    renderers.flat().forEach(renderer => renderer.predraw(setup.wrapped));
    let draws = 0, perSamplePixels = 0;
    await setup.compositePass((native, pass) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        native.setScissorRect(x, y, 1, 1);
        const orders = SAMPLE_POSITIONS[samples].map(offset => sampleReference(scene, x, y, offset).order);
        const keys = orders.map(order => order.map(e => e.kind + e.index).join());
        const runs = keys.every(key => key === keys[0]) ? [[0, orders[0]]] : orders.map((order, s) => [s + 1, order]);
        if (runs.length > 1) perSamplePixels++;
        for (const [mask, order] of runs) for (const element of order) {
          if (element.kind === 'glass') { native.setPipeline(glass[mask]); native.draw(6, 1, 6 * element.index); }
          else if (!renderers[element.index][mask].draw(pass)) throw new Error('reference splat draw was skipped');
          draws++;
        }
      }
    });
    return { pixels: toBase64(await setup.readColor()), cost: { draws, perSamplePixels } };
  } finally { for (const resource of setup.owned.reverse()) resource.destroy(); }
}

async function candidateFrame(ctx, scene) {
  const { raw, errors } = ctx, { size } = scene, samples = config.samples, K = config.layers;
  const peelSamples = config.peelRate === 'pixel' ? 1 : samples;
  const setup = await frameSetup(ctx, scene, peelSamples > 1);
  try {
    const { texture, own, depth, module, encoder } = setup;
    const peelBase = peelSamples === samples ? setup.opaqueDepth : texture('depth32float', 1, RA | TB);
    const peel = [peelBase, ...Array.from({ length: K }, () => texture('depth32float', peelSamples, RA | TB))];
    const ones = texture('depth32float', peelSamples, RA | TB), scratch = texture('depth32float', peelSamples, RA);
    const glassVertices = scene.glass.length * 6;
    const glassStage = (label, entryPoint, targets, depthStencil, count) => checkedPipeline(raw, { label, vertex: { module, entryPoint: 'vsGlass' },
      fragment: { module, entryPoint, targets }, depthStencil, multisample: { count } }, errors);
    const peelPipeline = await glassStage('peel', 'fsPeel', [], depth('less', true), peelSamples);
    const exhaustionPipeline = await glassStage('exhaustion', 'fsPeel', [], depth('always', false), peelSamples);
    // Opaque occlusion is the exact P_(k-1) >= P_0 interval bound; no fixed-function per-sample depth
    // test (SwiftShader evaluates it at x-mirrored sample offsets, see peel-probe.mjs).
    const compositePipeline = await glassStage('glass-composite', 'fsComposite', [{ format: 'rgba8unorm', blend: ALPHA_OVER }], depth('always', false), samples);
    const opaqueDepthOnly = peelBase === setup.opaqueDepth ? null : await checkedPipeline(raw, { label: 'opaque-depth-1x',
      vertex: { module, entryPoint: 'vsOpaque' }, depthStencil: depth('greater', true) }, errors);
    const renderer = setup.renderer(setup.splatData(scene.splats));
    if (samples > 1) renderer.model.setParameters({ ...renderer.model.parameters, sampleCount: samples });
    const setSplatInterval = (lower, upper) => renderer.model.setBindings({ splatDepthLower: setup.luma(lower), splatDepthUpper: setup.luma(upper) });
    setSplatInterval(peel[0], ones);
    const querySet = own(raw.createQuerySet({ type: 'occlusion', count: 1 }));
    const resolved = own(raw.createBuffer({ size: 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }));
    const readback = own(raw.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const cost = { renderPasses: 0, draws: 0, splatIntervalDraws: 0, glassLayerDraws: 0, peelPasses: K, splatSortsPerFrame: 1, constantSetupPasses: 0 };
    const bind = (pipeline, textures) => raw.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: textures.map((t, binding) => ({ binding, resource: t.createView() })) });
    const depthPass = (target, clear, draw, extra = {}) => {
      if (draw) cost.renderPasses++; else cost.constantSetupPasses++;
      const pass = encoder.beginRenderPass({ colorAttachments: [], ...extra,
        depthStencilAttachment: { view: target.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: clear } });
      if (draw) { draw(pass); cost.draws++; }
      pass.end();
    };
    setup.opaquePass(); cost.renderPasses++; cost.draws++;
    if (opaqueDepthOnly) depthPass(peelBase, 0, pass => { pass.setPipeline(opaqueDepthOnly); pass.draw(6); });
    depthPass(ones, 1); // constant +inf upper bound (clear only; reusable across frames)
    for (let k = 1; k <= K; k++) {
      depthPass(peel[k], 1, pass => { pass.setPipeline(peelPipeline); pass.setBindGroup(0, bind(peelPipeline, [peel[k - 1]])); pass.draw(glassVertices); });
    }
    depthPass(scratch, 1, pass => {
      pass.setPipeline(exhaustionPipeline); pass.setBindGroup(0, bind(exhaustionPipeline, [peel[K]]));
      pass.beginOcclusionQuery(0); pass.draw(glassVertices); pass.endOcclusionQuery();
    }, { occlusionQuerySet: querySet });
    renderer.predraw(setup.wrapped);
    cost.renderPasses++;
    encoder.resolveQuerySet(querySet, 0, 1, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, 8);
    await setup.compositePass((native, pass) => {
      const splats = (lower, upper) => {
        setSplatInterval(lower, upper);
        if (!renderer.draw(pass)) throw new Error('candidate splat draw was skipped');
        const runs = renderer.getDrawRuns().length;
        cost.draws += runs; cost.splatIntervalDraws += runs;
      };
      const glassLayer = (lower, upper) => {
        native.setPipeline(compositePipeline); native.setBindGroup(0, bind(compositePipeline, [lower, upper]));
        if (config.glassOrder === 'reversed') {
          for (let i = scene.glass.length - 1; i >= 0; i--) { native.draw(6, 1, 6 * i); cost.draws++; cost.glassLayerDraws++; }
        } else { native.draw(glassVertices); cost.draws++; cost.glassLayerDraws++; }
      };
      const layers = () => { for (let k = 1; k <= K; k++) glassLayer(peel[k - 1], peel[k]); };
      if (config.schedule === 'splats-first') { splats(peel[0], ones); layers(); }
      else if (config.schedule === 'glass-first') { layers(); splats(peel[0], ones); }
      else {
        for (let k = 1; k <= K; k++) { splats(peel[k - 1], peel[k]); glassLayer(peel[k - 1], peel[k]); }
        splats(peel[K], ones);
      }
    });
    await readback.mapAsync(GPUMapMode.READ);
    const occlusionCount = Number(new BigUint64Array(readback.getMappedRange())[0]);
    readback.unmap();
    // Diagnostic: every P_k sample equals the analytic k-th visible glass depth (or the 1.0 clear).
    const layerDepth = { mismatches: 0, maxError: 0, sentinelSamples: 0, firstMismatches: [] };
    for (let k = 1; k <= K; k++) {
      const depths = new Float32Array((await unpackSamples(raw, peel[k], { kind: 'depth', samples: peelSamples, size }, errors)).buffer);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) SAMPLE_POSITIONS[peelSamples].forEach((offset, s) => {
        const expected = sampleReference(scene, x, y, offset).layers[k - 1] ?? 1, got = depths[(y * size + x) * peelSamples + s];
        const ok = expected === 1 ? got === 1 : Math.abs(got - expected) <= LAYER_DEPTH_TOLERANCE;
        if (expected === 1) layerDepth.sentinelSamples++;
        else layerDepth.maxError = Math.max(layerDepth.maxError, Math.abs(got - expected));
        if (ok) return;
        layerDepth.mismatches++;
        if (layerDepth.firstMismatches.length < 6) {
          const center = sampleReference(scene, x, y, [0.5, 0.5]).layers[k - 1] ?? 1;
          layerDepth.firstMismatches.push({ k, x, y, s, expected, got, pixelCenterExpected: center });
        }
      });
    }
    const depthTextures = [...new Set([setup.opaqueDepth, ...peel, ones, scratch])];
    cost.depthTextureBytes = depthTextures.reduce((sum, t) => sum + size * size * t.sampleCount * 4, 0);
    return { pixels: toBase64(await setup.readColor()), exhaustion: { reported: occlusionCount > 0, occlusionCount }, layerDepth, cost };
  } finally { for (const resource of setup.owned.reverse()) resource.destroy(); }
}

/**
 * #8564 option B on the installed (production-patched) upstream renderer: P1 is the
 * fixed-function nearest glass depth; splats with depth <= P1 per sample, then the glass
 * with a depth test against opaque, then splats with depth > P1. A stencil count of glass
 * surfaces in front of opaque depth with an occlusion query reports samples beyond exact.
 */
async function nearestFrame(ctx, scene) {
  const { raw, errors } = ctx, { size } = scene, samples = config.samples;
  const setup = await frameSetup(ctx, scene, false);
  try {
    const { texture, own, depth, module, encoder } = setup;
    const glassVertices = scene.glass.length * 6;
    const nearest = texture('depth32float', samples, RA | TB);
    const counted = texture('depth24plus-stencil8', samples, RA);
    const p1 = await checkedPipeline(raw, { label: 'nearest-glass-depth', vertex: { module, entryPoint: 'vsGlass' },
      depthStencil: depth('greater', true), multisample: { count: samples } }, errors);
    const opaqueCount = await checkedPipeline(raw, { label: 'opaque-depth-stencil', vertex: { module, entryPoint: 'vsOpaque' },
      depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'greater', depthWriteEnabled: true }, multisample: { count: samples } }, errors);
    const increment = { compare: 'always', passOp: 'increment-clamp' };
    const glassCount = await checkedPipeline(raw, { label: 'glass-count', vertex: { module, entryPoint: 'vsGlass' }, multisample: { count: samples },
      depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'greater', depthWriteEnabled: false, stencilFront: increment, stencilBack: increment } }, errors);
    const quadModule = await checkedModule(raw, `@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); return vec4f(p[i], 0.0, 1.0); }`, 'layer-quad', errors);
    const quad = await checkedPipeline(raw, { label: 'layer-quad', vertex: { module: quadModule, entryPoint: 'vs' }, multisample: { count: samples },
      depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'always', depthWriteEnabled: false, stencilReadMask: 0xff, stencilWriteMask: 0,
        stencilFront: { compare: 'less-equal' }, stencilBack: { compare: 'less-equal' } } }, errors);
    const glassPipeline = await checkedPipeline(raw, { label: 'glass-depth-tested', vertex: { module, entryPoint: 'vsGlass' }, multisample: { count: samples },
      fragment: { module, entryPoint: 'fsGlass', targets: [{ format: 'rgba8unorm', blend: ALPHA_OVER }] }, depthStencil: depth('greater', false) }, errors);
    const data = setup.splatData(scene.splats);
    const renderer = own(new SplatRenderer(ctx.device, { data, viewportSize: [size, size], modelViewProjectionMatrix: scene.camera,
      depthCompare: 'greater', depthConvention: 'reverse', sphericalHarmonicsDegree: 0, toneMapping: 'none', depthIntervalSamples: samples }));
    if (renderer.props.depthIntervalSamples !== samples) throw new Error('installed @luma.gl/splats lacks the #8564 depth-interval hook');
    if (samples > 1) renderer.model.setParameters({ ...renderer.model.parameters, sampleCount: samples });
    const querySet = own(raw.createQuerySet({ type: 'occlusion', count: 1 }));
    const resolved = own(raw.createBuffer({ size: 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }));
    const readback = own(raw.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    setup.opaquePass();
    let pass = encoder.beginRenderPass({ colorAttachments: [],
      depthStencilAttachment: { view: nearest.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0 } });
    pass.setPipeline(p1); pass.draw(glassVertices); pass.end();
    pass = encoder.beginRenderPass({ colorAttachments: [], occlusionQuerySet: querySet, depthStencilAttachment: { view: counted.createView(),
      depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard', stencilClearValue: 0 } });
    pass.setPipeline(opaqueCount); pass.draw(6);
    pass.setPipeline(glassCount); pass.draw(glassVertices);
    pass.setPipeline(quad); pass.setStencilReference(2);
    pass.beginOcclusionQuery(0); pass.draw(3); pass.endOcclusionQuery(); pass.end();
    encoder.resolveQuerySet(querySet, 0, 1, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, 8);
    renderer.predraw(setup.wrapped);
    const bound = setup.luma(nearest);
    await setup.compositePass((native, lumaPass) => {
      const splats = compare => {
        renderer.setProps({ depthInterval: { bound, compare } });
        if (!renderer.draw(lumaPass)) throw new Error('nearest splat draw was skipped');
      };
      if (!config.splitDisabled) splats('less-equal');
      native.setPipeline(glassPipeline); native.draw(glassVertices);
      if (config.splitDisabled) splats('less-equal');
      splats('greater');
    });
    await readback.mapAsync(GPUMapMode.READ);
    const multiLayerSamples = Number(new BigUint64Array(readback.getMappedRange())[0]);
    readback.unmap();
    return { pixels: toBase64(await setup.readColor()), layers: { multiLayerSamples, reported: multiLayerSamples > 0 ? 'multiple' : 'single' } };
  } finally { for (const resource of setup.owned.reverse()) resource.destroy(); }
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU required, no skip');
  const raw = await adapter.requestDevice(), errors = [];
  const report = message => { if (errors.length < 16 && !errors.includes(message)) errors.push(message); };
  raw.addEventListener('uncapturederror', event => report(event.error.message));
  const device = new WebGPUDevice({ createCanvasContext: false, onError: error => report(error.message) }, raw, adapter, adapter.info);
  try {
    const ctx = { raw, device, errors }, cases = [];
    const probe = config.samples > 1 ? await probeSampleShading(raw, errors) : null;
    // The references place samples by coverage masks at the standard positions. @builtin(position) under
    // sample shading reads the pixel centre on some backends (D3D12), so coverage and sample-interpolated
    // varyings at the standard positions also establish them.
    if (probe && !probe.standardPositions && !(probe.standardCoverage && probe.perSampleVaryingDepth)) {
      throw new Error(`Non-standard 4x sample positions: ${JSON.stringify(probe.positions)}`);
    }
    for (const panes of config.panes) for (const projection of ['orthographic', 'perspective']) for (const size of config.sizes) {
      const scene = { ...buildScene(size, projection, { panes }), camera: cameraFor(projection) };
      const started = performance.now();
      const frame = config.mode === 'reference' ? await referenceFrame(ctx, scene)
        : config.mode === 'nearest' ? await nearestFrame(ctx, scene) : await candidateFrame(ctx, scene);
      cases.push({ panes, projection, size, samples: config.samples, ...frame, wallMs: Math.round(performance.now() - started) });
    }
    const { vendor, architecture, description } = adapter.info ?? {};
    return { config, adapter: { vendor, architecture, description }, probe, cases, errors, productionReady: false };
  } finally { device.destroy(); raw.destroy(); }
}
window.peelWitness = run().then(result => ({ result }), error => ({ error: error.stack ?? String(error) }));
