/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as pc from 'playcanvas';
import { captureTexture } from './capture.mjs';
export async function playcanvasBackend(canvas, meshes, captures, placements) {
  const device = await pc.createGraphicsDevice(canvas, { deviceTypes: ['webgpu'], antialias: false });
  if (!device.isWebGPU) { device.destroy(); throw new Error('The spike requires WebGPU; fallback is not a pass.'); }
  const options = new pc.AppOptions(); options.graphicsDevice = device;
  options.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.GSplatComponentSystem];
  options.resourceHandlers = [pc.GSplatHandler];
  const app = new pc.AppBase(canvas); app.init(options);
  const ifc = new pc.Entity('IFC fixture'), captureRoot = new pc.Entity('Captures'), pointRoot = new pc.Entity('Points');
  app.root.addChild(ifc); app.root.addChild(captureRoot); app.root.addChild(pointRoot);
  const ownedMeshes = [], materials = [], assets = [], errors = [];
  device.wgpu.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const source of meshes) {
    for (let i = 0; i < source.positions.length; i++) { min[i % 3] = Math.min(min[i % 3], source.positions[i]); max[i % 3] = Math.max(max[i % 3], source.positions[i]); }
    const mesh = new pc.Mesh(device); mesh.setPositions(source.positions); mesh.setIndices(source.indices); mesh.update(); ownedMeshes.push(mesh);
    const material = new pc.StandardMaterial(); material.useLighting = false; material.emissive.set(...source.color.slice(0, 3)); material.cull = pc.CULLFACE_NONE; material.update(); materials.push(material);
    const entity = new pc.Entity(); entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] }); ifc.addChild(entity);
  }
  captures.forEach((data, i) => {
    const asset = new pc.Asset(`capture-${i}`, 'gsplat');
    asset.resource = new pc.GSplatResource(device, data); asset.loaded = true; app.assets.add(asset); assets.push(asset);
    const entity = new pc.Entity(`capture-${i}`); entity.addComponent('gsplat', { asset: asset.id });
    entity.setLocalPosition(...placements[i]); entity.setLocalEulerAngles(180, 0, 0); entity.setLocalScale(2, 2, 2); captureRoot.addChild(entity);
  });
  const center = min.map((v, i) => (v + max[i]) / 2), radius = Math.max(...max.map((v, i) => v - min[i]));
  const camera = new pc.Entity('Camera'); camera.addComponent('camera', { clearColor: new pc.Color(0.09, 0.13, 0.15), farClip: 1000 }); app.root.addChild(camera);
  const captureColor = new pc.Texture(device, { width: canvas.width, height: canvas.height, format: pc.PIXELFORMAT_RGBA8, mipmaps: false });
  const captureTarget = new pc.RenderTarget({ colorBuffer: captureColor, depth: true, samples: 1 });
  let alternate = false, disposed = false, pointCount = 0;
  function pose() { camera.setPosition(center[0] + radius * (alternate ? -1.2 : 1.2), center[1] + radius * 0.7, center[2] + radius * 1.2); camera.lookAt(...center); }
  pose(); app.autoRender = false; app.start();
  return {
    async capture() {
      camera.camera.renderTarget = captureTarget; app.render();
      try { return await captureTexture(device.wgpu, captureColor.impl.gpuTexture, canvas.width, canvas.height); }
      finally { camera.camera.renderTarget = null; }
    },
    draw() { if (!disposed) { app.update(0); app.render(); } },
    move() { alternate = !alternate; pose(); app.renderNextFrame = true; },
    toggle(kind) { const target = kind === 'ifc' ? ifc : kind === 'points' ? pointRoot : captureRoot; target.enabled = !target.enabled; app.renderNextFrame = true; },
    addPoints(chunk) {
      for (const child of [...pointRoot.children]) child.destroy();
      const mesh = new pc.Mesh(device); mesh.setPositions(chunk.positions);
      if (chunk.colors) mesh.setColors(chunk.colors, 3);
      mesh.update(pc.PRIMITIVE_POINTS, false); ownedMeshes.push(mesh);
      const material = new pc.StandardMaterial(); material.useLighting = false; material.emissive.set(1, 1, 1); material.emissiveVertexColor = Boolean(chunk.colors); material.update(); materials.push(material);
      const entity = new pc.Entity(); entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] }); pointRoot.addChild(entity); pointCount = chunk.pointCount; app.renderNextFrame = true;
    },
    stats() { return { backend: 'PlayCanvas 2.23.3', meshCount: meshes.length, splatCount: captures.reduce((n, data) => n + data.numSplats, 0), pointCount, errors, disposed, sharedDevice: true, center, radius, finiteMeshPositions: meshes.every(mesh => mesh.positions.every(Number.isFinite)), cameraPosition: camera.getPosition().toString(), drawCalls: app.stats.drawCalls.total }; },
    async destroy() { disposed = true; captureTarget.destroy(); captureColor.destroy(); app.destroy(); assets.forEach(asset => asset.unload()); ownedMeshes.forEach(mesh => mesh.destroy()); materials.forEach(material => material.destroy()); },
  };
}
