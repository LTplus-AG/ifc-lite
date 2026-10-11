/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '../../../../packages/renderer/src/index.js';

export type CaptureRenderRefusal = 'uninitialized' | 'pipeline' | 'lost' | 'collapsed'
  | 'context' | 'texture' | 'resize' | 'encode' | 'finish' | 'submit';

/** Controlled GPU interface; actual Renderer encoding/submission runs, with no physical GPU claim (#6709). */
export function installCaptureGpu(renderer: Renderer, canvas: HTMLCanvasElement, callbacks: {
  complete: () => Promise<void>;
  submit: () => void;
  resize: (width: number, height: number) => void;
}) {
  const enums = {
    GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 },
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  };
  const savedEnums = Object.keys(enums).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(enums)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  let refusal: CaptureRenderRefusal | null = null;
  const stats = { submissions: 0, encodedPasses: 0, finished: 0, pushedScopes: 0, poppedScopes: 0 };
  const pass = new Proxy({}, { get: () => () => {} });
  const encoder = new Proxy({}, { get: (_target, name) => {
    if (name === 'beginRenderPass') return () => {
      if (refusal === 'encode') throw new RangeError('controlled command encoding refusal');
      stats.encodedPasses++;
      return pass;
    };
    if (name === 'finish') return () => {
      if (refusal === 'finish') throw new RangeError('controlled command finish refusal');
      stats.finished++;
      return {};
    };
    return () => {};
  } });
  const device = new Proxy({}, { get: (_target, name) => {
    switch (name) {
      case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 };
      case 'queue': return {
        writeBuffer: () => {}, writeTexture: () => {}, copyExternalImageToTexture: () => {},
        onSubmittedWorkDone: callbacks.complete,
        submit: () => {
          if (refusal === 'submit') throw new RangeError('controlled queue submission refusal');
          stats.submissions++;
          callbacks.submit();
        },
      };
      case 'pushErrorScope': return () => { stats.pushedScopes++; };
      case 'popErrorScope': return () => { stats.poppedScopes++; return Promise.resolve(null); };
      case 'createCommandEncoder': return () => encoder;
      case 'createBuffer': return ({ size }: GPUBufferDescriptor) => {
        const data = new ArrayBuffer(size);
        return { size, getMappedRange: () => data, mapAsync: () => Promise.resolve(), unmap: () => {}, destroy: () => {} };
      };
      case 'createTexture': return (descriptor: GPUTextureDescriptor) => {
        const size = descriptor.size as GPUExtent3DDict;
        return { width: size.width, height: size.height ?? 1, createView: () => ({}), destroy: () => {} };
      };
      case 'createRenderPipeline': return () => ({ getBindGroupLayout: () => ({}) });
      default: return () => ({});
    }
  } });
  const context = {
    configure: () => { if (refusal === 'context') throw new Error('controlled context refusal'); },
    getCurrentTexture: () => refusal === 'texture' ? null : { createView: () => ({}) },
    unconfigure: () => {},
  };
  const pipeline = new Proxy({}, { get: (_target, name) => {
    switch (name) {
      case 'resize': return (width: number, height: number) => {
        if (refusal === 'resize') throw new RangeError('controlled target resize refusal');
        callbacks.resize(width, height);
      };
      case 'needsResize': return () => refusal === 'resize';
      case 'getSampleCount': return () => 1;
      case 'getMultisampleTextureView': case 'getQuantizedPipelineVariant': return () => null;
      case 'getUniformBufferSize': return () => 336;
      default: return () => ({});
    }
  } });
  const host = renderer['device'] as unknown as Record<string, unknown>;
  const state = renderer as unknown as Record<string, unknown>;
  Object.assign(host, { device, context, canvas, contextConfigured: true, lastWidth: canvas.width, lastHeight: canvas.height });
  state.pipeline = pipeline;
  return {
    stats,
    refuse(mode: CaptureRenderRefusal): () => void {
      refusal = mode;
      const rect = canvas.getBoundingClientRect;
      if (mode === 'uninitialized') host.device = null;
      if (mode === 'pipeline') state.pipeline = null;
      if (mode === 'lost') renderer['handleDeviceLost']({ message: 'controlled device loss', reason: 'unknown' });
      if (mode === 'collapsed') canvas.getBoundingClientRect = () => ({ ...rect(), width: 0, height: 0 });
      if (mode === 'context') host.contextConfigured = false;
      return () => {
        refusal = null;
        host.device = device;
        state.pipeline = pipeline;
        state.deviceLost = false;
        host.contextConfigured = true;
        canvas.getBoundingClientRect = rect;
      };
    },
    dispose() {
      renderer.destroy();
      for (const [name, descriptor] of savedEnums) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
