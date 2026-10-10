/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual actual-GPU qualification. Bundle this browser module before serving it.
// #6881: the full-depth copy is a same-submission oracle, never a runtime fallback.
import { PickDepthSample } from '../../packages/renderer/src/picker-depth-sample.js';
export async function runDepthOracle() {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
        throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const shader = device.createShaderModule({ code: `
 @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
 let p=array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
 return vec4<f32>(p[i],0.5,1);
 }
 @fragment fn fs(@builtin(position) p:vec4<f32>)->@builtin(frag_depth) f32 {
 return 0.1 + fract(p.x * 0.017 + p.y * 0.037) * 0.8;
 }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [] }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' } });
    const helper = new PickDepthSample(device);
    const pending = [];
    for (const [w, h] of [[4, 4], [67, 19], [1292, 1047]]) {
        const texture = device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
        for (const [x, y] of [[0, 0], [w - 1, h - 1], [Math.floor(w / 2), Math.floor(h / 2)], [1, h - 2]]) {
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: texture.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } });
            pass.setPipeline(pipeline);
            pass.draw(3);
            pass.end();
            const bounded = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            const resources = helper.encode(encoder, texture, x, y, bounded, 4);
            const stride = Math.ceil(w * 4 / 256) * 256;
            const full = device.createBuffer({ size: stride * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer: full, bytesPerRow: stride, rowsPerImage: h }, { width: w, height: h });
            device.queue.submit([encoder.finish()]);
            pending.push((async () => {
                try {
                    await Promise.all([bounded.mapAsync(GPUMapMode.READ), full.mapAsync(GPUMapMode.READ)]);
                    const actual = new Uint32Array(bounded.getMappedRange(), 4, 1)[0];
                    const oracle = new Uint32Array(full.getMappedRange(), y * stride + x * 4, 1)[0];
                    if (actual !== oracle)
                        throw new Error(`Mismatch ${w}x${h} @ ${x},${y}: ${actual} != ${oracle}`);
                    return { w, h, x, y, actual, oracle, fullBytes: stride * h, boundedBytes: 20 };
                }
                finally {
                    for (const b of [bounded, full, ...resources])
                        b.destroy();
                }
            })());
        }
        // Destroy and replace targets while all asynchronous maps remain pending.
        texture.destroy();
    }
    const results = await Promise.all(pending);
    await device.queue.onSubmittedWorkDone();
    const info = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
    device.destroy();
    if (errors.length)
        throw new Error(errors.join('\n'));
    return { info, results, errors };
}
import { Picker } from '../../packages/renderer/src/picker.js';
import { Camera } from '../../packages/renderer/src/camera.js';
import { unprojectPickSample, restoreRtePickWorld } from '../../packages/renderer/src/pick-world-position.js';
export async function runPickerOracle() {
    const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const orig = device.createTexture.bind(device);
    device.createTexture = d => orig(d.format === 'depth32float' ? { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC } : d);
    const picker = new Picker({ getDevice: () => device });
    const pendingOracles = [];
    const encode = picker.depthSample.encode.bind(picker.depthSample);
    picker.depthSample.encode = (encoder, texture, x, y, staging, offset) => {
        const resources = encode(encoder, texture, x, y, staging, offset);
        const stride = Math.ceil(texture.width * 4 / 256) * 256;
        const full = device.createBuffer({ size: stride * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer: full, bytesPerRow: stride }, { width: texture.width, height: texture.height });
        pendingOracles.push({ full, stride, x, y, width: texture.width, height: texture.height });
        return resources;
    };
    const vertices = new Float32Array([-1, -1, 0, 0, 0, 1, 0, 1, -1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, -1, 1, 0, 0, 0, 1, 0]);
    const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexBuffer, 0, vertices);
    const indexBuffer = device.createBuffer({ size: 24, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indexBuffer, 0, new Uint32Array([0, 1, 2, 0, 2, 3]));
    const camera = new Camera();
    camera.setPosition(5000000, 0, 2);
    camera.setTarget(5000000, 0, 0);
    camera.setAspect(1);
    const snapshot = camera.getRelativeToEyeFrame().snapshot(), matrix = snapshot.getViewProjection().m;
    const mesh = { expressId: 123, modelIndex: 7, geometryItemId: 456, vertexBuffer, indexBuffer, indexCount: 6, transform: { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }, rteOrigin: [5000000, 0, 0], color: [1, 1, 1, 1] };
    const calls = [];
    for (const [x, y, w, h, clip] of [[32, 32, 64, 64, null], [0, 0, 64, 64, null], [-1, -1, 67, 67, null], [1000, 1000, 67, 67, null], [20, 20, 67, 67, { clipBox: { min: [0, 0, 0], max: [1, 1, 1], enabled: true } }]]) {
        calls.push(picker.pick(x, y, w, h, [mesh], matrix, undefined, undefined, undefined, clip, snapshot));
    }
    // A camera change while all maps are in-flight must not alter captured RTE.
    camera.setPosition(5000001, 0, 2);
    const actual = await Promise.all(calls);
    const expected = [];
    for (const o of pendingOracles) {
        try {
            await o.full.mapAsync(GPUMapMode.READ);
            const depth = new Float32Array(o.full.getMappedRange(), o.y * o.stride + o.x * 4, 1)[0];
            const world = restoreRtePickWorld(unprojectPickSample(matrix, o.x, o.y, o.width, o.height, depth), snapshot);
            expected.push(world);
        }
        finally {
            o.full.destroy();
        }
    }
    for (let i = 0; i < actual.length; i++) {
        const a = actual[i], e = expected[i];
        if (e === null) {
            if (a !== null)
                throw new Error('Expected clipped/no-hit result');
        }
        else {
            if (a?.expressId !== 123 || a.modelIndex !== 7 || a.geometryItemId !== 456 || JSON.stringify(a.worldXYZ) !== JSON.stringify(e))
                throw new Error('Pick mismatch ' + JSON.stringify({ a, e }));
        }
    }
    picker.destroy();
    vertexBuffer.destroy();
    indexBuffer.destroy();
    const late = await picker.pick(1, 1, 4, 4, [], matrix);
    if (late !== null)
        throw new Error('Destroyed picker returned hit');
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    if (errors.length)
        throw new Error(errors.join('\n'));
    return { actual, expected, errors };
}
export async function runDeviceLossOracle() {
    const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
    const picker = new Picker({ getDevice: () => device });
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const pending = [picker.pick(0, 0, 4, 4, [], matrix), picker.pick(3, 3, 4, 4, [], matrix)];
    // mapAsync was issued synchronously; destroy completes pending GPU maps.
    device.destroy();
    const results = await Promise.all(pending);
    picker.destroy();
    if (results.some(value => value !== null))
        throw new Error('Device-loss picks did not degrade to null');
    return { results };
}

// Exercise the existing complete renderer witness with real framebuffer density
// controls. These override the density input; the adapter remains actual hardware.
import { runWitness } from '../../apps/viewer/src/e2e/RteGpuWitness.tsx';
import { runRendererDensityControls } from '../../scripts/perf/renderer-density-admission.mjs';
export async function runRendererDensityOracle() {
    return runRendererDensityControls({ window, document, runWitness, observeDepthCopies });
}

/** Test instrumentation only: append a full-copy oracle to each real pick. */
function observeDepthCopies(renderer, samples, density) {
    const picker = renderer.picker;
    if (!picker.depthSample) return; // the archived baseline already uses full copies
    const device = renderer.getGPUDevice();
    const createTexture = device.createTexture.bind(device);
    device.createTexture = descriptor => createTexture(descriptor.format === 'depth32float'
        ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor);
    const initial = picker.depthTexture;
    picker.depthTexture = device.createTexture({ size: [initial.width, initial.height], format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    initial.destroy();
    const encode = picker.depthSample.encode.bind(picker.depthSample);
    picker.depthSample.encode = (encoder, texture, x, y, staging, offset) => {
        const resources = encode(encoder, texture, x, y, staging, offset);
        const stride = Math.ceil(texture.width * 4 / 256) * 256;
        const full = device.createBuffer({ size: stride * texture.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        encoder.copyTextureToBuffer({ texture, aspect: 'depth-only' }, { buffer: full, bytesPerRow: stride },
            { width: texture.width, height: texture.height });
        const sample = { density, encodedId: null, width: texture.width, height: texture.height, x, y, actual: null, oracle: null };
        const mappedRange = staging.getMappedRange.bind(staging);
        staging.getMappedRange = (...args) => {
            const bytes = mappedRange(...args);
            sample.actual = new Uint32Array(bytes, offset, 1)[0];
            sample.encodedId = new Uint32Array(bytes, 0, 1)[0];
            return bytes;
        };
        // The caller submits before this microtask maps the independent oracle.
        const operation = Promise.resolve().then(async () => {
            try {
                await full.mapAsync(GPUMapMode.READ);
                sample.oracle = new Uint32Array(full.getMappedRange(), y * stride + x * 4, 1)[0];
                return sample;
            } finally { full.destroy(); }
        });
        // A failed witness can destroy the device before the controller joins
        // this map. Retain the original rejection for the report and drain.
        operation.catch(error => console.warn('[Depth oracle] native map failed:', error));
        samples.push(operation);
        return resources;
    };
}
