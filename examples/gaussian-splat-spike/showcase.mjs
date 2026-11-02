/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 RESEARCH PREVIEW capture page. Renders one hash-verified licensed
// Gaussian capture with the complete upstream PlayCanvas engine and drives
// its camera along demo-camera.mjs. It is not the production viewer, draws no
// IFC overlay and establishes no metric scale. record-showcase.mjs drives it.
import * as pc from 'playcanvas';
import { MemoryReadFileSystem, readFile, materializeToDataTable, createChunkDataPool } from '@playcanvas/splat-transform';
import { demoCameraAt, DEMO_DURATION_SECONDS } from './demo-camera.mjs';
import { DISPLAY_ROTATIONS, robustFraming } from './showcase-framing.mjs';
import { captureTexture } from './capture.mjs';

const params = new URLSearchParams(location.search);
const canvas = document.querySelector('#scene');
const status = document.querySelector('#status');
const width = Number(params.get('width') ?? 1920), height = Number(params.get('height') ?? 1080);
const state = window.showcase = { ready: false, error: null, phase: 'starting', errors: [] };
const say = text => { state.phase = text; status.textContent = text; };
const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');

async function fetchVerified(path, sha256, bytes) {
  const response = await fetch(`/fixtures/${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) !== bytes) throw new Error('fixture length differs from manifest');
  const data = new Uint8Array(bytes);
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > bytes) throw new Error('fixture body exceeds manifest length');
    data.set(value, offset); offset += value.length; state.loadedBytes = offset;
  }
  if (offset !== bytes) throw new Error('truncated fixture body');
  const digest = hex(await crypto.subtle.digest('SHA-256', data));
  if (digest !== sha256) throw new Error(`fixture SHA-256 mismatch: ${digest}`);
  return data;
}

async function decodePly(bytes) {
  const fs = new MemoryReadFileSystem();
  fs.set('capture.ply', bytes);
  const pool = createChunkDataPool({ maxPooledBytes: 32 * 1024 * 1024 });
  let sources = [];
  try {
    sources = await readFile({ filename: 'capture.ply', inputFormat: 'ply', fileSystem: fs });
    if (sources.length !== 1) throw new Error('expected one Gaussian source');
    return await materializeToDataTable(sources[0], pool);
  } finally { for (const source of sources) source.close(); pool.destroy(); }
}

try {
  const expected = { path: params.get('asset'), sha256: params.get('sha256'), bytes: Number(params.get('bytes')), count: Number(params.get('count')) };
  const rotation = params.get('rotation') ?? 'x180';
  if (!DISPLAY_ROTATIONS[rotation]) throw new Error(`unknown rotation ${rotation}`);
  say(`Loading ${expected.path} (${expected.bytes} bytes) and verifying SHA-256…`);
  const loadStart = performance.now();
  const table = await decodePly(await fetchVerified(expected.path, expected.sha256, expected.bytes));
  if (table.numRows !== expected.count) throw new Error(`decoded ${table.numRows} rows, manifest says ${expected.count}`);
  const column = name => table.getColumnByName(name)?.data;
  for (const c of table.columns) if (!(c.data instanceof Float32Array)) throw new Error(`non-float column ${c.name}`);
  const autoFraming = robustFraming(column('x'), column('y'), column('z'), column('opacity'), { rotation });
  const override = params.get('framing')?.split(',').map(Number);
  if (override && (override.length !== 4 || !override.every(Number.isFinite) || override[3] <= 0)) throw new Error('framing must be cx,cy,cz,radius');
  const framing = {
    center: override ? override.slice(0, 3) : autoFraming.center,
    radius: override ? override[3] : autoFraming.radius,
    initialAzimuth: Number(params.get('azimuth') ?? 0),
  };
  say('Creating WebGPU device and uploading splats…');
  const device = await pc.createGraphicsDevice(canvas, { deviceTypes: ['webgpu'], antialias: false, powerPreference: 'high-performance' });
  if (!device.isWebGPU) { device.destroy(); throw new Error('WebGPU required; a WebGL fallback is not this capture'); }
  device.wgpu.addEventListener('uncapturederror', event => { if (state.errors.length < 8) state.errors.push(event.error.message); });
  const info = device.gpuAdapter?.info ?? {};
  state.adapter = { vendor: info.vendor, architecture: info.architecture, description: info.description, fallback: device.gpuAdapter?.isFallbackAdapter ?? info.isFallbackAdapter ?? null };
  const options = new pc.AppOptions();
  options.graphicsDevice = device;
  options.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
  options.resourceHandlers = [pc.GSplatHandler];
  const app = new pc.AppBase(canvas);
  app.init(options);
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_FIXED, width, height);
  const data = new pc.GSplatData([{ name: 'vertex', count: table.numRows,
    properties: table.columns.map(c => ({ name: c.name, type: 'float', byteSize: 4, storage: c.data })) }]);
  const asset = new pc.Asset('capture', 'gsplat');
  asset.resource = new pc.GSplatResource(device, data); asset.loaded = true; app.assets.add(asset);
  const splat = new pc.Entity('capture');
  splat.addComponent('gsplat', { asset: asset.id });
  splat.setLocalEulerAngles(...DISPLAY_ROTATIONS[rotation].eulerDegrees);
  app.root.addChild(splat);
  const camera = new pc.Entity('camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0, 0, 0, 1), fov: 55, nearClip: framing.radius * 0.01,
    farClip: framing.radius * 60, toneMapping: pc.TONEMAP_LINEAR, gammaCorrection: pc.GAMMA_SRGB });
  app.root.addChild(camera);
  const lookTarget = new pc.Vec3();
  const setPose = seconds => {
    const pose = demoCameraAt(seconds, framing);
    camera.setPosition(...pose.position); camera.lookAt(lookTarget.set(...pose.target));
    return pose;
  };
  let sorts = 0;
  app.scene.on('gsplat:sorted', () => { sorts++; });
  const nextFrame = () => new Promise(resolve => app.once('frameend', resolve));
  // PlayCanvas 2.23 sorts on the GPU inside each frame on WebGPU (renderer 2);
  // only its CPU path (renderer 1) answers through a worker 'gsplat:sorted' event.
  const gpuSort = () => app.scene.gsplat?.currentRenderer === (pc.GSPLAT_RENDERER_RASTER_GPU_SORT ?? 2);
  const settle = async () => {
    const before = sorts;
    if (!gpuSort()) for (let i = 0; i < 180 && sorts <= before; i++) await nextFrame();
    for (let i = 0; i < 4; i++) await nextFrame();
    return gpuSort() || sorts > before;
  };
  const stillColor = new pc.Texture(device, { width, height, format: pc.PIXELFORMAT_RGBA8, mipmaps: false });
  const stillTarget = new pc.RenderTarget({ colorBuffer: stillColor, depth: true, samples: 1 });
  setPose(0); app.autoRender = true; app.start();
  const sortedAtStart = await settle();

  let recording = null;
  Object.assign(state, {
    playcanvas: pc.version, numSplats: data.numSplats, shBands: data.shBands, rotation,
    framing, autoFraming, loadToFirstSettledFrameMs: performance.now() - loadStart, sortedAtStart,
    gsplatRenderer: app.scene.gsplat?.currentRenderer, sortPath: gpuSort() ? 'gpu-in-frame' : 'cpu-worker',
    supportedTypes: ['video/webm;codecs=vp9', 'video/mp4;codecs=avc1.640033', 'video/webm;codecs=av01', 'video/webm']
      .filter(type => MediaRecorder.isTypeSupported(type)),
    async still(seconds, azimuth = framing.initialAzimuth) {
      framing.initialAzimuth = azimuth;
      const pose = setPose(seconds);
      const settled = await settle();
      camera.camera.renderTarget = stillTarget;
      let pending;
      try { app.render(); pending = captureTexture(device.wgpu, stillColor.impl.gpuTexture, width, height); }
      finally { camera.camera.renderTarget = null; }
      return { ...(await pending), pose, settled, azimuth };
    },
    async record({ seconds = DEMO_DURATION_SECONDS, tail = 0.25, fps = 30, mimeType, bitsPerSecond = 40e6 }) {
      setPose(0); await settle();
      const stream = canvas.captureStream(fps);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPerSecond });
      const chunks = [], frames = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = event => reject(event.error); });
      let t0 = null;
      // Wall-clock journey on the engine's own update/render loop.
      const onUpdate = () => {
        const now = performance.now();
        t0 ??= now;
        const elapsed = (now - t0) / 1000;
        setPose(Math.min(elapsed, seconds)); frames.push(elapsed);
        if (elapsed >= seconds + tail && recorder.state === 'recording') recorder.stop();
      };
      recorder.start(1000);
      app.on('update', onUpdate);
      try { await stopped; } finally { app.off('update', onUpdate); stream.getTracks().forEach(track => track.stop()); }
      const blob = new Blob(chunks, { type: recorder.mimeType });
      recording = blob;
      return { mimeType: recorder.mimeType, bytes: blob.size, frames, sortsDuringRecording: sorts };
    },
    // Diagnostic only: engine frames per second while idle at one pose.
    async frameRate(ms = 2000) {
      let frames = 0;
      const count = () => { frames++; };
      app.on('frameend', count);
      const start = performance.now();
      await new Promise(resolve => setTimeout(resolve, ms));
      app.off('frameend', count);
      return frames / ((performance.now() - start) / 1000);
    },
    async readRecording(offset, length) {
      const slice = new Uint8Array(await recording.slice(offset, offset + length).arrayBuffer());
      let binary = '';
      for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
      return btoa(binary);
    },
  });
  state.ready = true;
  say(`Ready: ${data.numSplats} splats, SH bands ${data.shBands}`);
} catch (error) {
  state.error = error.stack ?? String(error); say(state.error); console.error(error);
}
