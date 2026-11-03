/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 real-asset readback: FZK-Haus (its own windows and glazing, meshed by the
// published @ifc-lite/wasm runtime) with a licensed capture (Marcel Padilla, CC-BY-4.0)
// placed inside, seen from outside through a window. The renderer is a Vite alias:
// this branch (role=head) or the K-layer research renderer (role=k-layer). Placement is
// artificial and non-metric. Measurements only; native-adapter-real-glass-check.mjs judges.
import { Renderer, normalizeGaussianAttributes } from 'ifc-lite-renderer-under-test';
import { loadCaptureColumns, loadIfcMeshes } from './native-adapter-demo-assets.mjs';

const role = new URLSearchParams(location.search).get('role') ?? 'head';
let BLACK = { clearColor: [0, 0, 0, 1], visualEnhancement: { enabled: false } };
let WHITE = { ...BLACK, clearColor: [1, 1, 1, 1] };
/** Not physical; the viewer hides them by default. Everything else of FZK-Haus draws. */
const NON_PHYSICAL = new Set(['IfcSpace', 'IfcOpeningElement']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rx180 = ([x, y, z], s) => ({ matrix: Float64Array.from([s, 0, 0, 0, 0, -s, 0, 0, 0, 0, -s, 0, x, y, z, 1]) });

function boundsOf(mesh) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], o = mesh.origin ?? [0, 0, 0];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = mesh.positions[i + a] + o[a];
    min[a] = Math.min(min[a], v); max[a] = Math.max(max[a], v);
  }
  return { min, max };
}

async function frame(renderer, device, options) {
  for (let deferred = 0; !renderer.renderWithResult(options); deferred++) { if (deferred > 2000) throw new Error('no frame'); await delay(10); }
  await device.queue.onSubmittedWorkDone();
}
/** Two consecutive identical frames, else the last frame and how much it still changed. */
async function capture(renderer, device, options) {
  let previous = null, jitter = null;
  for (let n = 0; n < 8; n++) {
    await frame(renderer, device, options);
    let settled = false;
    const pending = renderer.captureColorFrame().finally(() => { settled = true; });
    for (let attempt = 0; attempt < 6 && !settled; attempt++) { await frame(renderer, device, options); await delay(0); }
    const next = await pending;
    if (!next) throw new Error('capture cancelled');
    if (previous && next.rgba.every((v, i) => v === previous.rgba[i])) return { frame: next, stable: true };
    if (previous) {
      let changed = 0, maxDelta = 0;
      for (let i = 0; i < next.rgba.length; i++) { const d = Math.abs(next.rgba[i] - previous.rgba[i]); if (d) { changed++; maxDelta = Math.max(maxDelta, d); } }
      jitter = { changedChannels: changed, maxDelta };
    }
    previous = next;
  }
  return { frame: previous, stable: false, jitter };
}
async function encode({ frame, stable, jitter = null }) {
  const toBase64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  return { width: frame.width, height: frame.height, stable, jitter, rgba: toBase64(new Uint8Array(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength)), png: toBase64(png) };
}
/** A few frames so asynchronous pipelines and the layer count settle before a capture. */
async function settle(renderer, device, options) { for (let n = 0; n < 24; n++) { await frame(renderer, device, options); await delay(10); } }

async function run() {
  const renderer = new Renderer(document.querySelector('canvas'));
  await renderer.init();
  const device = renderer.getGPUDevice(), errors = [];
  device.addEventListener('uncapturederror', event => { if (errors.length < 16) errors.push(event.error.message); });
  const { meshes } = await loadIfcMeshes();
  const upload = renderer.loadGeometry(meshes);
  if (upload && upload.ok === false) throw new Error(`IFC upload failed: ${upload.reason}`);
  const model = renderer.getModelBounds();
  const centre = [(model.min.x + model.max.x) / 2, (model.min.y + model.max.y) / 2, (model.min.z + model.max.z) / 2];
  // The largest glazing pane of an IfcWindow; its thin horizontal axis is the view direction.
  const glazing = meshes.filter(m => m.ifcType === 'IfcWindow' && m.color[3] < 0.99).map(m => ({ mesh: m, ...boundsOf(m) }))
    .map(w => ({ ...w, size: w.max.map((v, a) => v - w.min[a]) })).filter(w => Math.min(w.size[0], w.size[2]) < 0.2)
    .sort((a, b) => Math.max(b.size[0], b.size[2]) * b.size[1] - Math.max(a.size[0], a.size[2]) * a.size[1]);
  if (!glazing.length) throw new Error('FZK-Haus: no IfcWindow glazing found');
  const params = new URLSearchParams(location.search);
  const windowIds = new Set(meshes.filter(m => m.ifcType === 'IfcWindow').map(m => m.expressId));
  const allIds = new Set(meshes.map(m => m.expressId));
  const nonPhysical = new Set(meshes.filter(m => NON_PHYSICAL.has(m.ifcType)).map(m => m.expressId));
  BLACK = { ...BLACK, hiddenIds: nonPhysical }; WHITE = { ...WHITE, hiddenIds: nonPhysical };
  const translucentTypes = {};
  for (const m of meshes) if (m.color[3] < 0.99) translucentTypes[m.ifcType] = (translucentTypes[m.ifcType] ?? 0) + 1;
  const attributes = normalizeGaussianAttributes(await loadCaptureColumns('/fixtures/plant.splat', 'splat'));
  const splats = renderer.gaussianSplats, camera = renderer.getCamera();
  const away = rx180([centre[0], centre[1] - 1000, centre[2]], 1);
  const handle = await splats.add({ attributes, placement: away, modelIndex: 0 }, { qualification: 'internal-unqualified' });
  for (let i = 0; i < 240 && splats.getState(handle).state !== 'resident'; i++) await frame(renderer, device, BLACK);
  /** View one pane from 3.2 m outside; the capture's placement `depth` metres inside it. */
  const pose = (pane, depth) => {
    const axis = pane.size[0] < pane.size[2] ? 0 : 2, c = pane.min.map((v, a) => (v + pane.max[a]) / 2), n = [0, 0, 0];
    n[axis] = Math.sign(c[axis] - centre[axis]) || 1;
    camera.setFOV(Math.PI / 4); camera.setUp(0, 1, 0);
    camera.setPosition(c[0] + n[0] * 3.2, c[1], c[2] + n[2] * 3.2); camera.setTarget(...c);
    // Plant source-frame y spans -0.40..0.46; flipped at scale 1 it stands centred on the pane.
    return { c, n, placement: rx180([c[0] - n[0] * depth, c[1] + 0.03, c[2] - n[2] * depth], 1) };
  };
  const place = async placement => { await splats.setPlacement(handle, placement); await settle(renderer, device, BLACK); };
  const quick = async () => (await capture(renderer, device, BLACK)).frame;
  // This branch picks the first pane and depth where the capture is visible through the glass;
  // the K-layer run reuses that choice (query string), so both render the identical scene.
  let chosen = params.has('pane') ? { pane: glazing.find(g => g.mesh.expressId === Number(params.get('pane'))), depth: Number(params.get('depth')) } : null;
  const search = [];
  paneSearch: for (const pane of chosen ? [] : glazing.slice(0, 8)) for (const depth of [0.5, 0.9, 1.5]) {
    const { placement } = pose(pane, depth);
    await place(away); const without = await quick();
    await place(placement); const withCapture = await quick();
    let changed = 0;
    for (let i = 0; i < without.rgba.length; i += 4) if (Math.abs(without.rgba[i + 1] - withCapture.rgba[i + 1]) > 8) changed++;
    search.push({ pane: pane.mesh.expressId, depth, changed });
    if (changed >= 400) { chosen = { pane, depth }; break paneSearch; }
  }
  if (!chosen?.pane) throw new Error(`no pane shows the capture: ${JSON.stringify(search)}`);
  const view = pose(chosen.pane, chosen.depth);
  const pane = chosen.pane;
  const frames = {}, reports = {};
  const shot = async (name, options, placement) => {
    await place(placement);
    await settle(renderer, device, options);
    frames[name] = await encode(await capture(renderer, device, options));
    reports[name] = JSON.parse(JSON.stringify(splats.getStats().compositionReport ?? splats.getStats().composition ?? null));
  };
  await shot('away', BLACK, away);
  await shot('split', BLACK, view.placement);
  if (role === 'head') {
    splats.setCompositionMode('single-pass');
    await shot('single', BLACK, view.placement);
    splats.setCompositionMode('nearest-glass-split');
    // Independent reference with only the windows: glass over black, over white, and the capture alone.
    const others = new Set([...allIds].filter(id => !windowIds.has(id)));
    const only = (o, hidden) => ({ ...o, hiddenIds: new Set([...hidden, ...nonPhysical]) });
    await shot('windowsBlack', only(BLACK, others), away);
    await shot('windowsWhite', only(WHITE, others), away);
    await shot('frontWindowBlack', only(BLACK, new Set([...allIds].filter(id => id !== pane.mesh.expressId))), away);
    await shot('captureAlone', only(BLACK, allIds), view.placement);
    await shot('windowsSplit', only(BLACK, others), view.placement);
    frames.windowsSplitRepeat = await encode(await capture(renderer, device, only(BLACK, others)));
  }
  const diagnostics = renderer.getDiagnostics();
  const info = { role, pane: { expressId: pane.mesh.expressId, centre: view.c, normal: view.n, size: pane.size, color: pane.mesh.color },
    depth: chosen.depth, search, translucentTypes, hiddenNonPhysical: nonPhysical.size, glazingCount: glazing.length, splats: attributes.count, sampleCount: renderer['pipeline']?.getSampleCount?.(),
    drawnFrames: splats.getStats().drawnFrames };
  renderer.destroy();
  return { frames, reports, errors, info, diagnostics: { renderErrors: diagnostics.errors, gpuErrors: diagnostics.gpuErrors }, adapterInfo: renderer.getAdapterInfo?.() };
}

window.realGlass = run().then(result => ({ result }), error => ({ error: error instanceof Error ? error.stack : String(error) }));
