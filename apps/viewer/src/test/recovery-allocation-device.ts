/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Memory allocation boundary only. Renderer.init/recoverDevice, pipelines,
 * loss subscriptions and Scene restoration remain their production methods.
 * This does not simulate a driver, shader execution or submitted frames. */
export function recoveryAllocationDevice() {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  Object.assign(globalThis, {
    GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  });
  const losses = [deferred<Pick<GPUDeviceLostInfo, 'reason' | 'message'>>(), deferred<Pick<GPUDeviceLostInfo, 'reason' | 'message'>>()];
  const requested = deferred<void>(), replacement = deferred<void>();
  const live = new Set<GPUBuffer>();
  const limits = { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30,
    maxTextureDimension2D: 4096, maxSampleCount: 1 };
  const pipeline = () => ({ getBindGroupLayout() { return {}; } });
  const devices = losses.map(loss => ({
    limits, features: new Set(), lost: loss.promise,
    destroy() { loss.resolve({ reason: 'destroyed', message: 'Owned allocation device teardown' }); },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const bytes = new ArrayBuffer(descriptor.size);
      const buffer = { size: descriptor.size, usage: descriptor.usage, label: descriptor.label ?? '',
        getMappedRange() { return bytes; }, unmap() {}, destroy() { live.delete(buffer as unknown as GPUBuffer); } };
      live.add(buffer as unknown as GPUBuffer); return buffer;
    },
    createTexture() { return { createView() { return {}; }, destroy() {} }; },
    createSampler() { return {}; }, createBindGroup() { return {}; },
    createBindGroupLayout() { return {}; }, createPipelineLayout() { return {}; },
    createShaderModule() { return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createRenderPipeline: pipeline, createComputePipeline: pipeline,
    createRenderPipelineAsync: async () => pipeline(),
    pushErrorScope() {}, popErrorScope: async () => null,
    queue: { writeBuffer() {}, writeTexture() {}, copyExternalImageToTexture() {}, submit() {} },
  } as unknown as GPUDevice));
  let deviceRequests = 0;
  const gpu = {
    getPreferredCanvasFormat: () => 'bgra8unorm',
    requestAdapter: async () => ({ limits, features: new Set(), info: {},
      requestDevice: async () => {
        const index = deviceRequests++;
        if (index > 1) throw new Error('Only the initial and one replacement allocation device are supported');
        if (index === 1) { requested.resolve(); await replacement.promise; }
        return devices[index];
      },
    }),
  } as unknown as GPU;
  const oldGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpu });
  // Full Renderer.init constructs an empty text atlas. Allow its allocation
  // and clear only; glyph measurement/drawing intentionally remain unsupported.
  const oldCanvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
    value: function (kind: string) {
      if (kind === '2d') return { clearRect() {} };
      throw new Error('Only empty 2D atlas allocation is supported at this prototype boundary');
    },
  });
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
  const context = { configure() {}, unconfigure() {},
    getCurrentTexture() { return { createView() { return {}; } }; } };
  Object.defineProperty(canvas, 'getContext', { value: (kind: string) => {
    if (kind !== 'webgpu') throw new Error('Only the production WebGPU context is supported at this boundary');
    return context;
  } });
  return { canvas, devices, live, replacementRequested: requested.promise,
    loseBeforeFirstFlatUpload() { losses[0].resolve({ reason: 'unknown', message: 'Controlled loss before native flat upload' }); },
    releaseReplacement() { replacement.resolve(); },
    restore() {
      if (oldGpu) Object.defineProperty(navigator, 'gpu', oldGpu);
      else Reflect.deleteProperty(navigator, 'gpu');
      if (oldCanvasContext) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', oldCanvasContext);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
    },
  };
}
