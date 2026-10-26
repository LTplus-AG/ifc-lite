/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Manual hardware instrumentation for #6881. Never imported by the viewer.
import { decodePickSample } from '../../packages/renderer/src/point-picker.js';
import { resolvePickSample } from '../../packages/renderer/src/pick-resolve.js';
import { unprojectPickSample, restoreRtePickWorld } from '../../packages/renderer/src/pick-world-position.js';

/** Locate the already mounted renderer without constructing another renderer. */
export function mountedRenderer(canvas) {
  const key = Object.keys(canvas).find(key => key.startsWith('__reactFiber$'));
  let fiber = canvas[key];
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState;
    for (let index = 0; hook && index < 300; index++, hook = hook.next) {
      const value = hook.memoizedState?.current;
      if (value && typeof value.getCamera === 'function' && typeof value.getScene === 'function'
        && typeof value.pick === 'function') return value;
    }
  }
  throw Error('Mounted renderer ref unavailable');
}

export function installOracle({ depthBitXor = 0, renderer: suppliedRenderer } = {}) {
  if (depthBitXor !== 0 && depthBitXor !== 1) throw Error('Unknown oracle fault control');
  if (globalThis.__6881) throw Error('An oracle already owns this document');
  const canvas = suppliedRenderer?.getCanvas() ?? document.querySelector('canvas[data-viewport="main"]');
  if (!canvas) throw Error('Main canvas absent');
  const renderer = suppliedRenderer ?? mountedRenderer(canvas), picker = renderer.picker;
  if (!picker?.depthSample) throw Error('Production bounded picker unavailable');
  const device = renderer.getGPUDevice(), samples = [], pending = new Set();
  const owned = new Set();
  const originalPick = picker.pick, originalEncode = picker.depthSample.encode;
  const originalCreate = device.createTexture;
  let active = null, retired = false;
  // Future resizes must preserve the independent oracle's COPY_SRC usage.
  const create = function(descriptor) {
    return originalCreate.call(this, descriptor.format === 'depth32float' && active
      ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor);
  };
  device.createTexture = create;
  const initial = picker.depthTexture;
  if (initial) {
    picker.depthTexture = create.call(device, { size: [initial.width, initial.height], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    initial.destroy();
  }
  const encode = function(encoder, texture, x, y, staging, offset) {
    if (!active) throw Error('Depth encode outside owned point pick');
    const row = active, resources = originalEncode.call(this, encoder, texture, x, y, staging, offset);
    const stride = Math.ceil(texture.width * 4 / 256) * 256;
    const depthBytes = stride * texture.height;
    const full = device.createBuffer({ size: depthBytes + 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    owned.add(full);
    encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer: full, bytesPerRow: stride },
      { width: texture.width, height: texture.height });
    encoder.copyTextureToBuffer({ texture: picker.colorTexture, origin: { x, y } },
      { buffer: full, offset: depthBytes, bytesPerRow: 256 }, { width: 1, height: 1 });
    Object.assign(row, { x, y, width: texture.width, height: texture.height, depthBytes });
    const range = staging.getMappedRange;
    staging.getMappedRange = function(...args) {
      const bytes = range.apply(this, args);
      row.actualId = new Uint32Array(bytes, 0, 1)[0];
      row.actualDepth = new Uint32Array(bytes, offset, 1)[0];
      return bytes;
    };
    // The production call submits synchronously before this microtask maps.
    row.oracle = Promise.resolve().then(async () => {
      try {
        await full.mapAsync(GPUMapMode.READ);
        const bytes = full.getMappedRange();
        return { id: new Uint32Array(bytes, depthBytes, 1)[0],
          depthBits: new Uint32Array(bytes, y * stride + x * 4, 1)[0],
          depth: new Float32Array(bytes, y * stride + x * 4, 1)[0] };
      } finally { full.destroy(); owned.delete(full); }
    });
    // Join on both success and failure; avoid an unhandled early rejection.
    void row.oracle.catch(error => { row.oracleError = String(error); });
    return resources;
  };
  picker.depthSample.encode = encode;
  const pick = async function(...args) {
    if (retired) throw Error('Retired oracle invoked');
    const [inputX, inputY, width, height, meshes, matrix, nodes, , templates, clip, snapshot] = args;
    const projection = new Float32Array(snapshot ? snapshot.getViewProjection().m : matrix);
    const cameraWorld = snapshot ? Array.from(snapshot.getCameraWorld()) : null;
    const row = { inputX, inputY, viewport: [width, height], matrix: Array.from(projection), cameraWorld,
      meshCount: meshes.length, instanceTemplates: templates?.length ?? 0, pointNodes: nodes?.length ?? 0,
      clip: clip ? { sectionPlane: clip.sectionPlane, clipBox: clip.clipBox, extraPlanes: clip.extraPlanes } : null,
      label: api.label, renderEpoch: snapshot?.renderEpoch };
    let operation;
    active = row;
    try { operation = originalPick.apply(this, args); } finally { active = null; }
    const task = (async () => {
      try {
        const actual = await operation;
        if (!row.oracle) throw Error('No same-render depth oracle was encoded');
        const oracle = await row.oracle;
        const relative = unprojectPickSample(projection, row.x, row.y, row.width, row.height, oracle.depth);
        const world = snapshot ? restoreRtePickWorld(relative, snapshot) : relative;
        const decoded = decodePickSample(oracle.id);
        const expected = resolvePickSample(decoded, meshes, nodes, world);
        Object.assign(row, { actual, expected, kind: decoded.kind, oracleId: oracle.id, oracleDepth: oracle.depthBits });
        row.depthBitXor = depthBitXor;
        if (row.actualDepth !== ((oracle.depthBits ^ depthBitXor) >>> 0) || row.actualId !== oracle.id
          || JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Same-render point pick mismatch');
        row.ok = true;
        return actual;
      } catch (error) {
        // Failed production readbacks still own their independent oracle map.
        if (row.oracle) await Promise.allSettled([row.oracle]);
        row.error = String(error);
        throw error;
      }
      finally { delete row.oracle; samples.push(row); }
    })();
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  };
  picker.pick = pick;
  const api = {
    label: 'unlabelled',
    samples,
    renderer,
    async drain() {
      const results = await Promise.allSettled(pending);
      if (results.some(result => result.status === 'rejected')) throw Error('Pending oracle failed');
      if (samples.some(row => !row.ok)) throw Error('An oracle comparison failed');
      return samples;
    },
    async retire() {
      await Promise.allSettled(pending);
      retired = true;
      if (picker.pick === pick) picker.pick = originalPick;
      if (picker.depthSample.encode === encode) picker.depthSample.encode = originalEncode;
      if (device.createTexture === create) device.createTexture = originalCreate;
      const oracleBuffersDestroyed = owned.size;
      for (const buffer of owned) buffer.destroy();
      owned.clear();
      if (globalThis.__6881 === api) delete globalThis.__6881;
      return { pending: pending.size, oracleBuffersDestroyed };
    },
  };
  globalThis.__6881 = api;
  return { installed: true };
}

/** Real completed maps are held while the current viewport/camera/device changes. */
export async function runLifecycle({ includeLoss = false } = {}) {
  if (globalThis.__6881 || globalThis.__6881Hover) throw Error('Retire other observers before lifecycle controls');
  const canvas = document.querySelector('canvas[data-viewport="main"]'), renderer = mountedRenderer(canvas);
  const device = renderer.getGPUDevice(), camera = renderer.getCamera(), reports = [];
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function phase(name, mutate, restore) {
    const originalCreate = device.createBuffer, buffers = [], picker = renderer.picker, originalPick = picker.pick;
    let completed = 0, release, insidePick = false;
    const pick = function(...args) {
      insidePick = true;
      try { return originalPick.apply(this, args); } finally { insidePick = false; }
    };
    picker.pick = pick;
    const gate = new Promise(resolve => { release = resolve; });
    const create = function(descriptor) {
      const buffer = originalCreate.call(this, descriptor);
      if (!insidePick) return buffer;
      const row = { size: buffer.size, usage: buffer.usage, destroys: 0 };
      buffers.push(row);
      const destroy = buffer.destroy;
      buffer.destroy = function() { row.destroys++; return destroy.call(this); };
      if (buffer.usage & GPUBufferUsage.MAP_READ) {
        const map = buffer.mapAsync;
        buffer.mapAsync = async function(...args) {
          const value = await map.apply(this, args);
          completed++;
          await gate;
          return value;
        };
      }
      return buffer;
    };
    device.createBuffer = create;
    const rect = canvas.getBoundingClientRect();
    const operations = [renderer.pick(rect.width * 0.4, rect.height * 0.4), renderer.pick(rect.width * 0.6, rect.height * 0.6)];
    // Catch immediately while retaining failures for the joined results.
    for (const operation of operations) void operation.catch(error => console.warn('[6881 lifecycle]', error));
    let results;
    try {
      const deadline = performance.now() + 5000;
      while (completed < 2) {
        if (performance.now() >= deadline) throw Error('Two actual GPU maps did not complete within five seconds');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await mutate();
      release();
      results = await Promise.all(operations);
      if (results.some(value => value !== null)) throw Error(`${name} returned a stale pick`);
    } finally {
      release();
      await Promise.allSettled(operations);
      if (device.createBuffer === create) device.createBuffer = originalCreate;
      if (picker.pick === pick) picker.pick = originalPick;
      await restore?.();
    }
    if (buffers.length !== 6 || buffers.some(row => row.destroys !== 1)) throw Error(`${name} did not retire each of the six point-pick buffers exactly once`);
    reports.push({ name, completedMaps: completed, results, buffers });
  }
  const position = { ...camera.getPosition() };
  await phase('camera-change-after-completed-maps', async () => {
    camera.setPosition(position.x + 1, position.y, position.z);
    renderer.requestRender(); await frame(); await frame();
  }, async () => {
    camera.setPosition(position.x, position.y, position.z);
    renderer.requestRender(); await frame(); await frame();
  });
  const originalStyle = canvas.getAttribute('style'), width = canvas.getBoundingClientRect().width;
  await phase('resize-after-completed-maps', async () => {
    canvas.style.width = `${width - 40}px`;
    await frame(); await frame();
  }, async () => {
    if (originalStyle === null) canvas.removeAttribute('style'); else canvas.setAttribute('style', originalStyle);
    renderer.requestRender(); await frame(); await frame();
  });
  if (includeLoss) await phase('device-loss-after-completed-maps', async () => {
    device.destroy(); await device.lost;
  });
  return reports;
}
