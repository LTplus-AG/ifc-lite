/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 IFC-only regression page: no Gaussian API. The renderer under test is a
// Vite alias, pointed at the base or head checkout by the runner, so the same
// inputs exercise batched meshes, an authored addMesh() individual mesh and the
// selection-highlight path (per-mesh uniform allocation) on both commits, and
// transparent IFC (#8564 moved its draws): glass batches, a partially hidden
// transparent batch (a transparent sub-batch), X-Ray ghosts, selected glass and
// an orthographic view (geometric-depth colour variants). An instanced translucent box
// overlaps the partially hidden glass batch, so the partial-batch versus transparent-
// instance blend order is visible in the pixels (#8564 review F2).
import { Renderer, MathUtils } from 'ifc-lite-renderer-under-test';

const OPTIONS = { clearColor: [0, 0, 0, 1], visualEnhancement: { enabled: false } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]], [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]], [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]], [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
  ];
  const positions = [], normals = [], indices = [];
  for (const [normal, corners] of faces) {
    const base = positions.length / 3;
    for (const corner of corners) { positions.push(...corner); normals.push(...normal); }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}
const meshData = (expressId, min, max, color) => ({ expressId, ifcType: 'IfcBuildingElementProxy', ...box(min, max), color });

/** Public Renderer.addMesh(): caller-owned buffers in the documented 7-lane layout (position, normal, entity id). */
function authoredMesh(device, expressId, min, max, color) {
  const { positions, normals, indices } = box(min, max);
  const raw = new ArrayBuffer(positions.length / 3 * 28), f32 = new Float32Array(raw), u32 = new Uint32Array(raw);
  for (let i = 0; i < positions.length / 3; i++) {
    f32.set(positions.subarray(i * 3, i * 3 + 3), i * 7);
    f32.set(normals.subarray(i * 3, i * 3 + 3), i * 7 + 3);
    u32[i * 7 + 6] = expressId;
  }
  const vertexBuffer = device.createBuffer({ size: raw.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, raw);
  const indexBuffer = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(indexBuffer, 0, indices);
  return { expressId, vertexBuffer, indexBuffer, indexCount: indices.length, transform: MathUtils.identity(), color };
}

async function capture(renderer, device, options) {
  const frames = [];
  for (let n = 0; n < 6; n++) {
    for (let deferred = 0; !renderer.renderWithResult(options); deferred++) {
      if (deferred > 2000) throw new Error('renderer submitted no frame');
      await delay(10);
    }
    await device.queue.onSubmittedWorkDone();
    let settled = false;
    const pending = renderer.captureColorFrame().finally(() => { settled = true; });
    for (let attempt = 0; attempt < 6 && !settled; attempt++) { renderer.render(options); await device.queue.onSubmittedWorkDone(); await delay(0); }
    const frame = await pending;
    if (!frame) throw new Error('colour-frame capture cancelled');
    frames.push(frame);
    if (n > 0 && frames[n].rgba.every((v, i) => v === frames[n - 1].rgba[i])) return { frame, stable: true, frames: n + 1 };
  }
  return { frame: frames.at(-1), stable: false, frames: 6 };
}

async function encode(frame) {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', frame.rgba)), b => b.toString(16).padStart(2, '0')).join('');
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
  const toBase64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const rgba = new Uint8Array(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength);
  return { width: frame.width, height: frame.height, sha256: digest, rgba: toBase64(rgba), png: toBase64(png) };
}

async function run() {
  const canvas = document.querySelector('canvas');
  const renderer = new Renderer(canvas);
  await renderer.init();
  const device = renderer.getGPUDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const camera = renderer.getCamera();
  camera.setFOV(Math.PI / 4); camera.setUp(0, 1, 0); camera.setPosition(0, 0, 10); camera.setTarget(0, 0, 0);
  renderer.addMeshes([meshData(11, [-1.6, -0.9, -0.3], [-0.4, 0.9, 0.3], [0.8, 0.3, 0.2, 1]), meshData(12, [0.4, -0.9, -0.3], [1.6, 0.9, 0.3], [0.2, 0.5, 0.8, 1])]);
  renderer.addMesh(authoredMesh(device, 13, [-0.5, -1.4, 0.4], [0.5, -0.6, 0.9], [0.3, 0.75, 0.35, 1]));
  // Two panes of one glass colour share a batch, so hiding one leaves a transparent sub-batch.
  renderer.addMeshes([meshData(14, [-1.2, -0.4, 1.0], [0.0, 0.6, 1.05], [0.5, 0.8, 0.95, 0.4]), meshData(15, [0.1, -0.4, 1.2], [1.3, 0.6, 1.25], [0.5, 0.8, 0.95, 0.4])]);
  const box16 = box([-0.8, -0.2, 0.7], [-0.2, 0.4, 1.3]);
  renderer.getScene().addInstancedShard(device, { carriesItemIds: false,
    templates: [{ positions: box16.positions, normals: box16.normals, indices: box16.indices, origin: [0, 0, 0] }],
    instances: [{ templateIndex: 0, entityId: 16, color: [0.95, 0.55, 0.2, 1], transform: MathUtils.identity().m }] });
  const cases = { plain: OPTIONS, selectedBatched: { ...OPTIONS, selectedId: 12 }, selectedAuthored: { ...OPTIONS, selectedId: 13 },
    selectedSet: { ...OPTIONS, selectedIds: new Set([11, 13]) }, plainAgain: OPTIONS,
    glassPartial: { ...OPTIONS, hiddenIds: new Set([15]) }, selectedGlass: { ...OPTIONS, selectedId: 14 },
    xray: { ...OPTIONS, ghostExceptIds: new Set([11]) }, withoutInstances: { ...OPTIONS, hiddenIds: new Set([16]) },
    // X-Ray ghosting only the instance sends it through the transparent instanced sub-pass, over the partial glass batch.
    partialGlassTranslucentInstance: { ...OPTIONS, hiddenIds: new Set([15]), ghostExceptIds: new Set([11, 12, 13, 14]) } };
  const frames = {};
  const views = { orthographic: OPTIONS, orthographicXray: cases.xray };
  for (const [name, options] of [...Object.entries(cases), ...Object.entries(views)]) {
    if (name === 'orthographic') { camera.setProjectionMode('orthographic'); camera.setOrthoSize(2.5); }
    const { frame, stable, frames: count } = await capture(renderer, device, options);
    frames[name] = { ...(await encode(frame)), stable, frames: count };
  }
  const diagnostics = renderer.getDiagnostics();
  renderer.destroy();
  return { frames, errors, diagnostics: { renderErrors: diagnostics.errors, gpuErrors: diagnostics.gpuErrors, lastGpuError: diagnostics.lastGpuError }, adapterInfo: renderer.getAdapterInfo() };
}

window.ifcRegression = run().then(result => ({ result }), error => ({ error: error instanceof Error ? error.stack : String(error) }));
