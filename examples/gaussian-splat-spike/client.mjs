/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { decodeCapture, decodeIfc } from './decode.mjs';
import { E57StreamingSource } from '../../packages/pointcloud/src/streaming/e57-source.ts';
import { lumaBackend } from './luma-backend.mjs';
import { playcanvasBackend } from './playcanvas-backend.mjs';
const status = document.querySelector('#status');
const canvas = document.querySelector('#scene');
window.spike = { ready: false, error: null };
try {
  status.textContent = 'Decoding real captures with SplatTransform; IFC with published IFC-Lite WASM…';
  const captures = await Promise.all(['plant', 'textile_ball'].map(decodeCapture));
  const meshes = await decodeIfc();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]); max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  const center = min.map((v, i) => (v + max[i]) / 2);
  // Put both real captures on the front side of the house, deliberately
  // overlapping. These are test placements, not surveyed registration.
  const placements = [[center[0], min[1] + 1, max[2] + 1], [center[0] + 0.4, min[1] + 1, max[2] + 1.2]];
  const name = new URLSearchParams(location.search).get('backend') ?? 'luma';
  status.textContent = `Creating ${name} shared scene…`;
  const backend = await (name === 'playcanvas' ? playcanvasBackend : lumaBackend)(canvas, meshes, captures, placements);
  function update() { status.textContent = JSON.stringify(backend.stats(), null, 2); }
  for (const kind of ['ifc', 'points', 'splats']) document.querySelector(`#hide-${kind}`).onclick = () => { backend.toggle(kind); update(); };
  document.querySelector('#move').onclick = () => { backend.move(); update(); };
  document.querySelector('#dispose').onclick = async () => { await backend.destroy(); update(); };
  const loadScan = async file => {
    status.textContent = 'Reading first bounded E57 chunk locally…';
    const source = new E57StreamingSource(file, { downsample: { stride: 20 } });
    try {
      const info = await source.open();
      const chunk = await source.next(20000);
      if (!chunk) throw new Error('Scan produced no points');
      const p = chunk.positions;
      const origin = meshes.rtcOffset;
      const outMin = [Infinity, Infinity, Infinity], outMax = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i] - origin[0];
        const y = p[i + 2] - origin[2];
        const z = -(p[i + 1] - origin[1]);
        p.set([x, y, z], i);
        for (let a = 0; a < 3; a++) { outMin[a] = Math.min(outMin[a], p[i + a]); outMax[a] = Math.max(outMax[a], p[i + a]); }
      }
      backend.addPoints({ ...chunk, bbox: { min: outMin, max: outMax } });
      window.spike.scan = { previewSourcePointCount: info.totalPointCount, decodedPointCount: chunk.pointCount, sourceBytes: file.size, boundedPreview: true, placement: 'source coordinates, IFC RTC subtraction and Z-up to Y-up only' };
    } finally { source.close(); }
    update();
  };
  document.querySelector('#scan').onchange = async event => {
    try { await loadScan(event.target.files[0]); } catch (error) { window.spike.error = error.message; status.textContent = error.stack; console.error(error); }
  };
  Object.assign(window.spike, { ready: true, backend, ifcFrame: { rtcOffset: meshes.rtcOffset }, stats: () => backend.stats(), loadScan });
  // Warm a finite number of frames for asynchronous pipeline compilation;
  // this is functional validation, not a frame-rate benchmark.
  for (let i = 0; i < 12; i++) { backend.draw(); await new Promise(requestAnimationFrame); }
  update();
} catch (error) {
  window.spike.error = error.stack; status.textContent = error.stack; console.error(error);
}
