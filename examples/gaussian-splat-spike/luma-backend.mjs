/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { webgpuAdapter } from '@luma.gl/webgpu';
import { SplatRenderer, makeGPUSplatData } from '@luma.gl/splats';
import { MathUtils } from '../../packages/renderer/src/math.ts';
import { RelativeToEyeFrame } from '../../packages/renderer/src/relative-to-eye.ts';
import { PointCloudRenderer } from '../../packages/renderer/src/pointcloud/point-cloud-renderer.ts';
import { captureColumns } from './decode.mjs';
import { captureTexture } from './capture.mjs';
import { reverseZProbe } from './reverse-z-probe.mjs';
import { nativeMeshes } from './native-mesh.mjs';
export async function lumaBackend(canvas, meshes, captures, placements) {
  const errors = [];
  const device = await webgpuAdapter.create({ createCanvasContext: false, onError: error => { if (errors.length < 8 && !errors.includes(error.message)) errors.push(error.message); } });
  const gpu = device.handle;
  gpu.addEventListener('uncapturederror', event => { if (errors.length < 8 && !errors.includes(event.error.message)) errors.push(event.error.message); });
  const context = canvas.getContext('webgpu');
  context.configure({ device: gpu, format: 'rgba8unorm', alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
  const color = device.createTexture({ format: 'rgba8unorm', width: canvas.width, height: canvas.height, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const objectId = device.createTexture({ format: 'rgba8unorm', width: canvas.width, height: canvas.height, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const depth = device.createTexture({ format: 'depth24plus-stencil8', width: canvas.width, height: canvas.height, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const framebuffer = device.createFramebuffer({ colorAttachments: [color], depthStencilAttachment: depth });
  const batches = captures.map((data, i) => makeGPUSplatData(device, captureColumns(data, placements[i])));
  const splats = new SplatRenderer(device, { data: batches, depthCompare: 'greater', depthWriteEnabled: false, viewportSize: [canvas.width, canvas.height] });
  const meshPass = nativeMeshes(gpu, meshes);
  const points = new PointCloudRenderer(gpu, 'rgba8unorm', 'depth24plus-stencil8', 1);
  points.setOptions({ pointSize: 3 });
  let cloudHandle = null, pointCount = 0;
  let visibleIfc = true, visiblePoints = true, visibleSplats = true, disposed = false, alternate = false;
  const frame = new RelativeToEyeFrame();
  let center = [0, 0, 0], radius = 15;
  const all = meshes.flatMap(mesh => Array.from(mesh.positions));
  if (all.length) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < all.length; i++) { min[i % 3] = Math.min(min[i % 3], all[i]); max[i % 3] = Math.max(max[i % 3], all[i]); }
    center = min.map((v, i) => (v + max[i]) / 2); radius = Math.max(...max.map((v, i) => v - min[i]));
  }
  function draw() {
    if (disposed) return;
    const eye = { x: center[0] + radius * (alternate ? -1.2 : 1.2), y: center[1] + radius * 0.7, z: center[2] + radius * 1.2 };
    const view = MathUtils.lookAt(eye, { x: center[0], y: center[1], z: center[2] }, { x: 0, y: 1, z: 0 });
    const projection = MathUtils.perspectiveReverseZ(Math.PI / 4, canvas.width / canvas.height, 0.1, 1000);
    frame.update(eye, projection, view);
    const vp = MathUtils.multiply(projection, view).m;
    // Published SplatRenderer consumes native WebGPU clip Z directly.
    splats.setProps({ modelViewProjectionMatrix: vp, cameraPosition: [eye.x, eye.y, eye.z] });
    const encoder = device.createCommandEncoder({});
    if (visibleSplats) splats.predraw(encoder);
    const nativePass = encoder.handle.beginRenderPass({ colorAttachments: [color, objectId].map(texture => ({ view: texture.handle.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.09, 0.13, 0.15, 1] })), depthStencilAttachment: { view: depth.handle.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 } });
    if (visibleIfc) meshPass.draw(nativePass, vp);
    if (visiblePoints) points.draw(nativePass, { viewProj: frame.getViewProjection().m, relativeToEyeFrame: frame, viewport: { width: canvas.width, height: canvas.height } });
    nativePass.end();
    const pass = encoder.beginRenderPass({ framebuffer, clearColor: false, clearDepth: false, stencilReadOnly: true });
    if (visibleSplats) splats.draw(pass);
    pass.end();
    encoder.handle.copyTextureToTexture({ texture: color.handle }, { texture: context.getCurrentTexture() }, [canvas.width, canvas.height]);
    device.submit(encoder.finish());
  }
  return {
    reverseZProbe() { return reverseZProbe(device); },
    draw, capture() { draw(); return captureTexture(gpu, color.handle, canvas.width, canvas.height); }, move() { alternate = !alternate; draw(); },
    toggle(kind) { if (kind === 'ifc') visibleIfc = !visibleIfc; if (kind === 'points') visiblePoints = !visiblePoints; if (kind === 'splats') visibleSplats = !visibleSplats; draw(); },
    addPoints(chunk) {
      if (cloudHandle) points.removeAsset(cloudHandle);
      cloudHandle = points.beginAsset({ expressId: 1 }); points.appendChunk(cloudHandle, chunk); points.endAsset(cloudHandle);
      pointCount = chunk.pointCount; draw();
    },
    stats() { return { backend: 'luma.gl 9.4.2', ...splats.stats, meshCount: meshes.length, pointCount, errors, disposed, depthCompare: 'greater', sampleCount: 1, center, radius, meshVertices: meshes.reduce((n, mesh) => n + mesh.positions.length / 3, 0), finiteMeshPositions: meshes.every(mesh => mesh.positions.every(Number.isFinite)) }; },
    async destroy() {
      disposed = true; splats.destroy(); batches.forEach(batch => batch.destroy()); points.clear(); meshPass.destroy();
      framebuffer.destroy(); color.destroy(); objectId.destroy(); depth.destroy();
      await gpu.queue.onSubmittedWorkDone(); device.destroy();
    },
  };
}
