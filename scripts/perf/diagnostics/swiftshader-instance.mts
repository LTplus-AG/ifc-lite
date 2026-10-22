/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7655 diagnostic, not a benchmark: no IFC, React, renderer recovery or mocks.
// Run with DEBUG=pw:browser to retain GPU-process stderr alongside this JSON.
import { chromium, type Browser } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mainShaderSource } from '../../../packages/renderer/src/shaders/main.wgsl.js';
import { BEGIN_FRAME_CHROME_ARGS } from '../../../tests/benchmark/frames/begin-frame-driver.js';

const server = createServer((_request, response) => response.end('<!doctype html><canvas width="64" height="64"></canvas>'));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing server address');
const results: unknown[] = [];
try {
  for (let round = 1; round <= 5; round++) for (const variant of ['original', 'fixed'] as const) {
    const args = [...(variant === 'original'
      ? BEGIN_FRAME_CHROME_ARGS.filter(arg => arg !== '--use-angle=swiftshader')
      : BEGIN_FRAME_CHROME_ARGS), '--enable-logging=stderr'];
    let browser: Browser | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      browser = await chromium.launch({ headless: true, args, timeout: 30_000 });
      const launchedBrowser = browser;
      deadline = setTimeout(() => { void launchedBrowser.close(); }, 90_000);
      deadline.unref();
      const page = await browser.newPage();
      page.setDefaultTimeout(30_000);
      page.on('console', message => console.log(`[${variant}] ${message.text()}`));
      await page.goto(`http://127.0.0.1:${address.port}`);
      // tsx may emit this helper in functions serialized into the page.
      await page.addScriptTag({ content: 'globalThis.__name = (fn) => fn;' });
      const result = await page.evaluate(async (source) => {
        const events: unknown[] = [];
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter');
        const device = await adapter.requestDevice();
        let lost = false;
        void device.lost.then(info => {
          lost = true;
          events.push({ step: 'lost', reason: info.reason, message: info.message });
        });
        device.addEventListener('uncapturederror', event => events.push({ step: 'uncaptured', message: event.error.message }));
        const run = async (step: string, work: () => unknown) => {
          console.log(`starting ${step}`);
          try { await work(); events.push({ step, ok: true, lost }); }
          catch (error) { events.push({ step, ok: false, error: String(error), lost }); }
          console.log(JSON.stringify(events.at(-1)));
        };
        const simple = device.createShaderModule({ code: `
          @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            return vec4f(f32(i) * 0.1, 0.0, 0.0, 1.0);
          }
          @fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }
        ` });
        const descriptor: GPURenderPipelineDescriptor = { layout: 'auto',
          vertex: { module: simple, entryPoint: 'vs' },
          fragment: { module: simple, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] } };
        await run('simple-async-before-canvas', () => device.createRenderPipelineAsync(descriptor));
        await run('scope-before-canvas', async () => {
          device.pushErrorScope('validation');
          const error = await device.popErrorScope();
          if (error) throw error;
        });
        const canvas = document.querySelector('canvas')!;
        const context = canvas.getContext('webgpu')!;
        await run('configure', () => context.configure({ device, format: 'bgra8unorm' }));
        await run('getCurrentTexture', () => context.getCurrentTexture());
        await run('simple-async-after-canvas', () => device.createRenderPipelineAsync(descriptor));
        const module = device.createShaderModule({ code: source });
        for (const quantized of [false, true]) {
          const vertex: GPUVertexState = { module, entryPoint: quantized ? 'vs_main_quantized' : 'vs_main', buffers: [{
            arrayStride: quantized ? 12 : 28,
            attributes: quantized
              ? [{ shaderLocation: 0, offset: 0, format: 'uint16x4' }, { shaderLocation: 2, offset: 8, format: 'uint32' }]
              : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'uint32' }],
          }] };
          await run(`main-async-${quantized ? 'quantized' : 'f32'}`, () => device.createRenderPipelineAsync({ layout: 'auto', vertex,
            fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
            depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'greater' },
            multisample: { count: 4 } }));
        }
        await run('queue-finished', () => device.queue.onSubmittedWorkDone());
        await run('same-device-readback', async () => {
          const source = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
          const target = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          try {
            device.queue.writeBuffer(source, 0, new Uint32Array([0x7655]));
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(source, 0, target, 0, 4);
            device.queue.submit([encoder.finish()]);
            await target.mapAsync(GPUMapMode.READ);
            const actual = new Uint32Array(target.getMappedRange())[0];
            target.unmap();
            if (actual !== 0x7655) throw new Error(`readback mismatch: ${actual}`);
          } finally { source.destroy(); target.destroy(); }
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        const result = { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture }, lost, events: [...events] };
        context.unconfigure();
        device.destroy();
        return result;
      }, mainShaderSource);
      results.push({ round, variant, browser: browser.version(), args, result });
      console.log(JSON.stringify(results.at(-1)));
      if (variant === 'fixed' && (result.lost || result.events.some(event => {
        const recorded = event as { step?: string; ok?: boolean };
        return recorded.ok === false || recorded.step === 'uncaptured';
      }))) {
        throw new Error('Corrected SwiftShader configuration failed real pipeline/queue/readback checks');
      }
    } catch (error) {
      // The broken configuration can lose its GPU channel even before adapter
      // acquisition. Retain that outcome without skipping the fixed comparison.
      results.push({ round, variant, browser: browser?.version(), args, error: String(error) });
      if (variant === 'fixed') throw error;
    } finally { clearTimeout(deadline); await browser?.close(); }
  }
} finally {
  server.close();
  const output = process.env.INSTANCE_DIAGNOSTIC_OUT ?? '/tmp/swiftshader-instance.json';
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(results, null, 2));
}
