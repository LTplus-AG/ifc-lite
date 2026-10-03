/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Passed directly to Playwright: no imports, Node closures or transpilation helpers.
export async function canvasControl(input) {
  if (input.action === 'initialize') {
    const canvas = document.querySelector('canvas');
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    device.lost.then(function lost(info) { console.error('GPU_DEVICE_LOST', JSON.stringify({ reason: info.reason, message: info.message })); });
    device.addEventListener('uncapturederror', function uncaptured(event) { console.error('GPU_UNCAPTURED_ERROR', String(event.error)); });
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('No WebGPU canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    context.configure({ device, format, usage, alphaMode: 'opaque' });
    globalThis.gpuControl = { device, context, canvas, format, started: performance.now() };
    const limits = {}, deviceLimits = {};
    for (const key in adapter.limits) limits[key] = adapter.limits[key];
    for (const key in device.limits) deviceLimits[key] = device.limits[key];
    const info = adapter.info;
    return { format, usage, width: canvas.width, height: canvas.height, limits, deviceLimits,
      adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device,
        description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null };
  }
  const { device, context, canvas, format, started } = globalThis.gpuControl;
  if (input.action === 'presentation-frames') {
    for (let i = 0; i < 2; i++) await new Promise(function frame(resolve) { requestAnimationFrame(resolve); });
    return 2;
  }
  if (input.action === 'clear') {
    const stride = Math.ceil(canvas.width * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: stride * canvas.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.pushErrorScope('validation');
    const failures = [];
    let result;
    try {
      const texture = context.getCurrentTexture();
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(),
        clearValue: input.color, loadOp: 'clear', storeOp: 'store' }] });
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, { width: canvas.width, height: canvas.height });
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      await buffer.mapAsync(GPUMapMode.READ);
      const offset = Math.floor(canvas.height / 2) * stride + Math.floor(canvas.width / 2) * 4;
      const rawCenter = Array.from(new Uint8Array(buffer.getMappedRange(), offset, 4));
      result = { format, stride, rawCenter, submitted: true };
    } catch (error) { failures.push(error); }
    finally {
      try {
        const validation = await device.popErrorScope();
        if (validation) { console.error('GPU_VALIDATION_ERROR', validation.message); failures.push(new Error(`GPU validation: ${validation.message}`)); }
      } catch (error) { console.error('GPU_ERROR_SCOPE_FAILED', String(error)); failures.push(error); }
      try { buffer.destroy(); }
      catch (error) { console.error('GPU_BUFFER_DESTROY_ERROR', String(error)); failures.push(error); }
    }
    if (failures.length) throw failures[0];
    return result;
  }
  if (input.action === 'observe') {
    let frames = 0;
    const until = Math.max(started + 15000, performance.now() + 5000);
    while (performance.now() < until) {
      await new Promise(function frame(resolve) { requestAnimationFrame(resolve); }); frames++;
    }
    await device.queue.onSubmittedWorkDone();
    return { frames, activeMs: performance.now() - started };
  }
  throw new Error('Unknown graphics action');
}

export async function pngCenter(base64) {
  const response = await fetch(`data:image/png;base64,${base64}`);
  const image = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG decoding context unavailable');
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height,
      center: Array.from(context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data) };
  } finally { image.close(); }
}
