/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_OPAQUE_MODE,
  OpaqueDrawVariants,
  opaqueVariantDescriptor,
  resolveOpaqueDrawMode,
} from './opaque-draw-variants.js';

const mainModule = { label: 'main' } as unknown as GPUShaderModule;
const fastModule = { label: 'fast' } as unknown as GPUShaderModule;

const baseDescriptor = (): GPURenderPipelineDescriptor => ({
  label: 'opaque',
  layout: 'auto',
  vertex: { module: mainModule, entryPoint: 'vs_main' },
  fragment: { module: mainModule, entryPoint: 'fs_main', targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
  depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'greater' },
  multisample: { count: 4 },
});

describe('resolveOpaqueDrawMode', () => {
  const perspective = { perspective: true, clipping: false, edges: false };

  it('orthographic frames always draw with the base pipelines (the visibility pass guards only those)', () => {
    assert.deepEqual(resolveOpaqueDrawMode({ ...perspective, perspective: false }), BASE_OPAQUE_MODE);
  });

  it('drops the discards only while nothing can clip or hide a fragment', () => {
    assert.equal(resolveOpaqueDrawMode(perspective).discardFree, true);
    assert.equal(resolveOpaqueDrawMode({ ...perspective, clipping: true }).discardFree, false);
    assert.equal(resolveOpaqueDrawMode({ ...perspective, instancedDiscards: true }).discardFree, false);
    assert.equal(resolveOpaqueDrawMode({ ...perspective, instancedDiscards: false }).discardFree, true);
  });

  it('writes the object id exactly when the edge pass reads it', () => {
    assert.equal(resolveOpaqueDrawMode(perspective).objectId, false);
    assert.equal(resolveOpaqueDrawMode({ ...perspective, edges: true }).objectId, true);
  });
});

describe('opaqueVariantDescriptor', () => {
  it('keeps the base vertex stage so the twin writes the same depth the selection redraw matches', () => {
    const base = baseDescriptor();
    const twin = opaqueVariantDescriptor(base, { discardFree: true, objectId: true }, () => fastModule);
    assert.equal(twin.vertex, base.vertex);
    assert.equal(twin.fragment?.module, fastModule);
    assert.equal(twin.fragment?.entryPoint, 'fs_main');
    assert.equal(twin.depthStencil, base.depthStencil);
    assert.equal(twin.multisample, base.multisample);
  });

  it('keeps every target format (pass compatibility) and masks only the object-id writes', () => {
    const twin = opaqueVariantDescriptor(baseDescriptor(), { discardFree: false, objectId: false }, () => fastModule);
    const targets = [...(twin.fragment?.targets ?? [])];
    assert.deepEqual(targets.map((t) => t?.format), ['bgra8unorm', 'rgba8unorm']);
    assert.equal(targets[0]?.writeMask, undefined, 'colour is written');
    assert.equal(targets[1]?.writeMask, 0, 'object id is not');
    assert.equal(twin.fragment?.module, mainModule, 'a write-mask-only twin keeps the full shader');
  });
});

function fakeDevice() {
  const created: GPURenderPipelineDescriptor[] = [];
  const settle: { resolve: (p: GPURenderPipeline) => void; reject: (e: unknown) => void }[] = [];
  const device = {
    createShaderModule: () => fastModule,
    createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => {
      created.push(descriptor);
      return new Promise<GPURenderPipeline>((resolve, reject) => settle.push({ resolve, reject }));
    },
  } as unknown as GPUDevice;
  return { device, created, settle };
}

describe('OpaqueDrawVariants', () => {
  const bases = { flat: baseDescriptor(), quantized: baseDescriptor(), instanced: baseDescriptor() };
  const fast = { discardFree: true, objectId: false };

  it('never builds a twin for the base mode', () => {
    const { device, created } = fakeDevice();
    assert.equal(new OpaqueDrawVariants(device, 'src', bases).get('flat', BASE_OPAQUE_MODE), null);
    assert.equal(created.length, 0);
  });

  it('draws the base while the twin compiles, then the twin; requests each twin once', async () => {
    const { device, created, settle } = fakeDevice();
    const variants = new OpaqueDrawVariants(device, 'src', bases);
    assert.equal(variants.get('flat', fast), null);
    assert.equal(variants.get('flat', fast), null);
    assert.equal(created.length, 1, 'one async compile per twin');
    const ready = { label: 'twin' } as unknown as GPURenderPipeline;
    settle[0]!.resolve(ready);
    await Promise.resolve();
    assert.equal(variants.get('flat', fast), ready);
    assert.equal(variants.get('instanced', fast), null, 'kinds are independent');
    assert.equal(created.length, 2);
  });

  it('keeps the base for good when a backend rejects the twin, and after destroy', async () => {
    const { device, created, settle } = fakeDevice();
    const variants = new OpaqueDrawVariants(device, 'src', bases);
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      variants.get('quantized', fast);
      settle[0]!.reject(new Error('rejected'));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1, 'the failure is reported, not swallowed');
    assert.equal(variants.get('quantized', fast), null);
    assert.equal(created.length, 1, 'a rejected twin is not retried every frame');

    variants.get('flat', fast);
    variants.destroy();
    settle[1]!.resolve({} as GPURenderPipeline);
    await Promise.resolve();
    assert.equal(variants.get('flat', fast), null);
  });
});
