/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 runnable preview: the real viewer Renderer draws the FZK-Haus and licensed
// captures through the internal, unqualified Gaussian adapter on its own device
// and frame. Not production; readiness stays blocked. Launch with
// native-adapter-demo-server.mjs. Query: ?capture=seem (Seem Kirke church PLY),
// ?journey=1 (autoplay the 30 s demo-camera journey), ?center=x,y,z&radius=r&azimuth=deg.
import { Renderer, normalizeGaussianAttributes } from '../../../packages/renderer/src/index.ts';
import { DEMO_DURATION_SECONDS, demoCameraAt } from '../demo-camera.mjs';
import { loadCaptureColumns, loadIfcMeshes } from './native-adapter-demo-assets.mjs';

const QUALIFICATION = Object.freeze({ qualification: 'internal-unqualified' });
const canvas = document.querySelector('#scene');
const status = document.querySelector('#status');
const diagnostics = document.querySelector('#diagnostics');
const params = new URLSearchParams(location.search);
const demo = { ready: false, error: null, phase: 'starting', errors: [] };
window.nativeAdapterDemo = demo;

/** Column-major Rx(180 deg) * uniform scale, then translation: a user/demo placement, never alignment. */
const rx180 = ([x, y, z], s) => ({ matrix: Float64Array.from([s, 0, 0, 0, 0, -s, 0, 0, 0, 0, -s, 0, x, y, z, 1]) });

// ARTIFICIAL, non-metric placements chosen for this preview. Rx(180 deg) turns the
// captures' source frames (-Y up) upright; nothing here is surveyed or registered.
const CAPTURE_SETS = {
  default: {
    credit: 'Captures: Marcel Padilla, CC-BY-4.0 (artificially placed)',
    detail: 'houseplant and textile ball from github.com/marcelpadilla/splats @ c3e5ec0; non-metric, SH degree 0.',
    placementNote: 'Demo placement: 180° about X, scale 2, side by side 1.5 m in front of the model’s +Z face; artificially placed, not aligned, no metric scale.',
    // Source-frame 1st–99th percentile y: plant -0.40..0.46, ball -0.43..0.37; after the flip and
    // scale 2 their lowest Gaussians sit 0.92 and 0.74 below the origin, so both stand at min.y + 1.
    assets: ({ min, max }) => {
      const cx = (min[0] + max[0]) / 2;
      return [
        { id: 'plant', url: '/fixtures/plant.splat', format: 'splat', placement: rx180([cx - 0.7, min[1] + 1.92, max[2] + 1.5], 2) },
        { id: 'textile_ball', url: '/fixtures/textile_ball.splat', format: 'splat', placement: rx180([cx + 0.7, min[1] + 1.74, max[2] + 1.7], 2) },
      ];
    },
  },
  // Seem Kirke, Danmark: Peter Rødsgaard Rasmussen (roedsgaard), CC BY 4.0,
  // https://superspl.at/scene/e832997f (docs/research/gaussian-qualification/seem-source.json).
  seem: {
    credit: 'Capture: Seem Kirke, Danmark — Peter Rødsgaard Rasmussen (roedsgaard), CC BY 4.0 — artificially placed, not aligned, no metric scale',
    detail: 'superspl.at/scene/e832997f; the publisher’s quantized SOG expanded to PLY by @playcanvas/splat-transform 3.10.3 (not the lossless original); published higher-order SH are all zero; viewpoint changed.',
    placementNote: 'Demo placement: 180° about X (user/demo choice), unit scale, set 6 units behind the model; artificially placed, not aligned, no metric scale.',
    // Source-frame 1st–99th percentiles: x -17.5..17.3, y -20.0..0.1 (ground near 0), z -12.2..14.9.
    assets: ({ min, max }) => [{ id: 'seem-kirke-v1', url: '/fixtures-explicit/seem-kirke-v1.ply', format: 'ply',
      placement: rx180([(min[0] + max[0]) / 2 + 0.07, min[1], min[2] - 6 - 12.2], 1) }],
  },
};
const setName = params.get('capture') === 'seem' ? 'seem' : 'default';
const captureSet = CAPTURE_SETS[setName];
document.querySelector('#attribution-credit').textContent = captureSet.credit;
document.querySelector('#attribution-detail').textContent = captureSet.detail;
document.querySelector('#placement-note').textContent = captureSet.placementNote;

const vec = bounds => ({ min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] });
const union = (a, b) => b ? { min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) } : a;
function framingFor(bounds) {
  const parsed = name => params.get(name)?.split(',').map(Number);
  const center = parsed('center') ?? bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
  const radius = Number(params.get('radius') ?? Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i])) / 2);
  const initialAzimuth = Number(params.get('azimuth') ?? 0);
  if (center.length !== 3 || !center.every(Number.isFinite) || !(radius > 0) || !Number.isFinite(initialAzimuth)) throw new Error('Invalid framing query');
  return { center, radius, initialAzimuth };
}
function applyPose(camera, pose) {
  camera.setFOV(pose.fovDegrees * Math.PI / 180);
  camera.setUp(0, 1, 0);
  camera.setPosition(...pose.position);
  camera.setTarget(...pose.target);
}

function controls(renderer, onInteract) {
  const camera = renderer.getCamera();
  let drag = null;
  canvas.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY, pan: event.button !== 0 || event.shiftKey };
    canvas.setPointerCapture(event.pointerId);
    onInteract();
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.pan) camera.pan(dx, dy); else camera.orbit(dx, dy);
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    onInteract();
    const rect = canvas.getBoundingClientRect();
    camera.zoom(event.deltaY, false, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  }, { passive: false });
}
function toggle(id, initial, onChange) {
  const button = document.querySelector(id);
  let value = initial;
  button.setAttribute('aria-pressed', String(value));
  button.addEventListener('click', () => { value = !value; button.setAttribute('aria-pressed', String(value)); onChange(value); });
  return { set: next => { if (next !== value) button.click(); } };
}
const mib = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;

async function main() {
  const renderer = new Renderer(canvas);
  await renderer.init();
  renderer.getGPUDevice()?.addEventListener('uncapturederror', event => { if (demo.errors.length < 16) demo.errors.push(event.error.message); });
  demo.phase = 'ifc';
  const { meshes } = await loadIfcMeshes((done, total) => { status.textContent = `Meshing FZK-Haus (published @ifc-lite/wasm 10.6.1)… ${done}/${total}`; });
  const upload = renderer.loadGeometry(meshes);
  if (!upload.ok) throw new Error(`IFC upload failed: ${upload.reason}`);
  const model = vec(renderer.getModelBounds());
  const assets = captureSet.assets(model);
  const adapter = typeof renderer.gaussianSplats?.add === 'function' ? renderer.gaussianSplats : null;
  const handles = {}, counts = {};
  demo.phase = 'captures';
  for (const asset of adapter ? assets : []) {
    status.textContent = `Decoding ${asset.id} with @playcanvas/splat-transform 3.10.3 (${asset.format} reader)…`;
    const attributes = normalizeGaussianAttributes(await loadCaptureColumns(asset.url, asset.format));
    counts[asset.id] = { count: attributes.count, shDegree: attributes.sphericalHarmonicsDegree };
    status.textContent = `Uploading ${asset.id} (${attributes.count.toLocaleString()} Gaussians) to the viewer device…`;
    handles[asset.id] = await adapter.add({ attributes, placement: asset.placement, modelIndex: 0 }, QUALIFICATION);
  }
  const framing = framingFor(union(model, adapter?.getBounds() ?? null));
  const camera = renderer.getCamera();
  const state = { section: false, journey: params.get('journey') === '1', journeyStart: performance.now(), journeyTime: null };
  const home = () => applyPose(camera, demoCameraAt(0, framing));
  home();
  const sectionX = assets.reduce((sum, asset) => sum + asset.placement.matrix[12], 0) / assets.length;
  const options = () => ({
    clearColor: [0.07, 0.09, 0.1, 1],
    sectionPlane: state.section ? { axis: 'side', position: 50, enabled: true, flipped: false, showGizmo: false, showCap: true,
      showOutlines: true, normal: [1, 0, 0], distance: sectionX } : undefined,
  });
  const journey = toggle('#toggle-journey', state.journey, value => { state.journey = value; state.journeyStart = performance.now(); state.journeyTime = null; });
  controls(renderer, () => journey.set(false));
  const splats = toggle('#toggle-splats', true, value => { for (const handle of Object.values(handles)) adapter.setVisible(handle, value); });
  toggle('#toggle-section', false, value => { state.section = value; });
  toggle('#toggle-projection', false, value => camera.setProjectionMode(value ? 'orthographic' : 'perspective'));
  document.querySelector('#reset-view').addEventListener('click', () => { journey.set(false); camera.setProjectionMode('perspective'); home(); });
  const describe = () => {
    const readiness = renderer.getGaussianReadiness();
    return [`readiness: ${readiness.state}${readiness.reasons ? ` (${readiness.reasons.join(', ')})` : ''}`,
      adapter ? `captures: ${Object.entries(counts).map(([id, c]) => `${id} ${c.count.toLocaleString()} (SH ${c.shDegree})`).join(', ')}` : 'renderer.gaussianSplats unavailable: IFC only',
      `IFC meshes ${meshes.length}; MSAA ${renderer.getPipeline()?.getSampleCount() ?? '?'}x; GPU ${JSON.stringify(renderer.getAdapterInfo())}`,
      state.journey ? `journey ${(state.journeyTime ?? ((performance.now() - state.journeyStart) / 1000) % DEMO_DURATION_SECONDS).toFixed(1)} s` : 'drag: orbit · right/shift-drag: pan · wheel: zoom',
    ].join('\n');
  };
  const describeDiagnostics = () => {
    const stats = adapter?.getStats();
    return stats ? `splats ${stats.splats.toLocaleString()} (visible ${stats.visibleAssetSplats.toLocaleString()})\ncpuBytes ${mib(stats.cpuBytes)} · gpuBytes ${mib(stats.gpuBytes)}\nlastEncodeMs ${stats.lastEncodeMs.toFixed(1)} · drawnFrames ${stats.drawnFrames}\ncomposition ${stats.composition} · clipping ${stats.clipping}` : 'adapter unavailable';
  };
  let last = performance.now(), lastStatus = 0;
  const frame = now => {
    if (state.journey) applyPose(camera, demoCameraAt(state.journeyTime ?? ((now - state.journeyStart) / 1000) % DEMO_DURATION_SECONDS, framing));
    camera.update(now - last);
    last = now;
    renderer.render(options());
    if (now - lastStatus > 500) {
      status.textContent = describe();
      diagnostics.innerHTML = '<b>Diagnostics — diagnostic timing, not a benchmark</b>\n';
      diagnostics.append(describeDiagnostics());
      lastStatus = now;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  Object.assign(demo, {
    ready: true, phase: 'running', captureSet: setName, framing, counts, meshCount: meshes.length, modelBounds: model,
    placements: Object.fromEntries(assets.map(asset => [asset.id, Array.from(asset.placement.matrix)])),
    stats: () => ({ readiness: renderer.getGaussianReadiness(), gaussian: adapter?.getStats() ?? null, bounds: adapter?.getBounds() ?? null,
      states: Object.fromEntries(Object.entries(handles).map(([id, handle]) => [id, adapter.getState(handle)])),
      diagnostics: renderer.getDiagnostics(), adapterInfo: renderer.getAdapterInfo(), errors: demo.errors }),
    /** Freeze the journey at `seconds` for deterministic stills; null resumes wall-clock playback from 0. */
    setJourneyTime: seconds => { journey.set(true); state.journeyStart = performance.now(); state.journeyTime = seconds; lastStatus = 0; },
    setSplatsVisible: visible => splats.set(visible),
    capture: () => renderer.captureColorFrame(),
  });
}

main().catch(error => {
  demo.error = error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = `Failed: ${demo.error}`;
  console.error('[native-adapter-demo]', error);
});
