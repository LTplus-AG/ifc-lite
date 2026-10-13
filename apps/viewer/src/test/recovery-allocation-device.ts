/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Memory allocation boundary only. Renderer.init/recoverDevice, pipelines,
 * loss subscriptions and Scene restoration remain their production methods.
 * This does not simulate a driver, shader execution or submitted frames. */
export function recoveryAllocationDevice(options: { extraRecoveryAttempt?: boolean } = {}) {
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
  const losses = Array.from({ length: options.extraRecoveryAttempt ? 3 : 2 }, () => deferred<Pick<GPUDeviceLostInfo, 'reason' | 'message'>>());
  const requested = deferred<void>(), replacement = deferred<void>();
  const pipelineRequested = deferred<void>(), pipelineReleased = deferred<void>();
  let holdPipelines = false, failVertexAfter: number | null = null;
  const stagedVertices: GPUBuffer[] = [];
  const live = new Set<GPUBuffer>();
  const limits = { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30,
    maxTextureDimension2D: 4096, maxSampleCount: 1 };
  const pipeline = () => ({ getBindGroupLayout() { return {}; } });
  // Encoder/pass primitives only. The real Renderer still chooses passes,
  // binds its buffers, draws, finishes and submits; no shader execution occurs.
  const encoding = { passes: 0, draws: 0, submissions: 0 };
  const commandEncoder = () => {
    let finished = false, activePass = false;
    const beginPass = () => {
      if (finished || activePass) throw new Error('Allocation encoder pass lifetime violation');
      activePass = true; encoding.passes++;
      return {
        setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
        setViewport() {}, setScissorRect() {}, setBlendConstant() {}, setStencilReference() {},
        draw() { encoding.draws++; }, drawIndexed() { encoding.draws++; },
        dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {},
        end() {
          if (!activePass) throw new Error('Allocation pass already ended');
          activePass = false;
        },
      };
    };
    return {
      beginRenderPass: beginPass, beginComputePass: beginPass,
      copyBufferToBuffer() {}, copyTextureToBuffer() {}, copyTextureToTexture() {},
      clearBuffer() {}, resolveQuerySet() {},
      finish() {
        if (finished || activePass) throw new Error('Allocation encoder finish lifetime violation');
        finished = true; return {};
      },
    };
  };
  const devices = losses.map((loss, deviceIndex) => ({
    limits, features: new Set(), lost: loss.promise,
    destroy() { loss.resolve({ reason: 'destroyed', message: 'Owned allocation device teardown' }); },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const staged = deviceIndex > 0 && failVertexAfter !== null && (descriptor.usage & GPUBufferUsage.VERTEX) !== 0;
      if (staged && stagedVertices.length === failVertexAfter) {
        failVertexAfter = null;
        throw new DOMException('Controlled later retained-stream vertex allocation refusal', 'OperationError');
      }
      const bytes = new ArrayBuffer(descriptor.size);
      const buffer = { size: descriptor.size, usage: descriptor.usage, label: descriptor.label ?? '',
        getMappedRange() { return bytes; }, unmap() {}, destroy() { live.delete(buffer as unknown as GPUBuffer); } };
      live.add(buffer as unknown as GPUBuffer);
      if (staged) stagedVertices.push(buffer as unknown as GPUBuffer);
      return buffer;
    },
    createTexture() { return { createView() { return {}; }, destroy() {} }; },
    createSampler() { return {}; }, createBindGroup() { return {}; },
    createBindGroupLayout() { return {}; }, createPipelineLayout() { return {}; },
    createShaderModule() { return { getCompilationInfo: async () => ({ messages: [] }) }; },
    createRenderPipeline: pipeline, createComputePipeline: pipeline,
    createRenderPipelineAsync: async () => {
      if (deviceIndex > 0 && holdPipelines) { pipelineRequested.resolve(); await pipelineReleased.promise; }
      return pipeline();
    },
    createCommandEncoder: commandEncoder,
    pushErrorScope() {}, popErrorScope: async () => null,
    queue: { writeBuffer() {}, writeTexture() {}, copyExternalImageToTexture() {}, submit() { encoding.submissions++; }, onSubmittedWorkDone: async () => {} },
  } as unknown as GPUDevice));
  let deviceRequests = 0;
  const gpu = {
    getPreferredCanvasFormat: () => 'bgra8unorm',
    requestAdapter: async () => ({ limits, features: new Set(), info: {},
      requestDevice: async () => {
        const index = deviceRequests++;
        if (index >= devices.length) throw new Error('The bounded allocation device attempts were exhausted');
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
  return { canvas, devices, live, encoding, replacementRequested: requested.promise,
    deviceRequestCount: () => deviceRequests,
    loseInitialDevice(message: string) { losses[0].resolve({ reason: 'unknown', message }); },
    pipelineRequested: pipelineRequested.promise, stagedVertices,
    holdReplacementPipelines() { holdPipelines = true; },
    releaseReplacementPipelines() { pipelineReleased.resolve(); },
    failReplacementVertexAllocationAfter(successes: 0 | 1) { stagedVertices.length = 0; failVertexAfter = successes; },
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
