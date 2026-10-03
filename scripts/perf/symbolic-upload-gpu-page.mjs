/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 standalone actual-GPU ABI control; never invoked by the comparator.
// Plain serializable callback: no imported helper or transpiler closure.
export async function symbolicUploadGpuControl(installerSource) {
  const receipt = { status: 'started', scope: 'GPU-produced symbolic buffer input identity; not viewer/pixel/fidelity/performance',
    controls: [], gpuEvents: [], shaderCompilations: [], recorderDisposals: [], cleanup: 'pending' };
  const resources = [], failures = [], cleanupFailures = [];
  let device, recorder, lost, ending = false;
  const helpers = {
    require(ok, message) { if (!ok) throw new Error(message); },
    own(resource) { resources.push(resource); return resource; },
    disposeRecorder(phase) {
      if (!recorder) return;
      const current = recorder; recorder = null;
      let result;
      try { result = current.dispose(); }
      catch (error) {
        receipt.recorderDisposals.push({ phase, status: 'refused', reason: String(error) }); throw error;
      }
      receipt.recorderDisposals.push({ phase, status: result.status, reason: result.reason });
      helpers.require(result.status === 'disposed', `recorder disposal refused: ${result.reason}`);
    },
    async read(buffer) {
      const words = buffer.size / 4, uniform = buffer.usage === 72;
      const texture = helpers.own(device.createTexture({ label: 'gpu-control-r32', size: [words, 1],
        format: 'r32uint', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
      const stage = helpers.own(device.createBuffer({ label: 'gpu-control-stage', size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
      const bindings = uniform ? `@group(0) @binding(0) var<uniform> words: array<vec4<u32>, ${words / 4}>;` : '';
      const argumentsCode = uniform ? '@builtin(vertex_index) i: u32' : '@builtin(vertex_index) i: u32, @location(0) word: u32';
      const expression = uniform ? 'words[i / 4u][i % 4u]' : 'word';
      const module = device.createShaderModule({ code: `${bindings}
        struct Out { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) word: u32 }
        @vertex fn vs(${argumentsCode}) -> Out {
          var out: Out; out.position=vec4<f32>((f32(i)+0.5)/${words}.0*2.0-1.0,0.0,0.0,1.0);
          out.word=${expression}; return out;
        }
        @fragment fn fs(in: Out) -> @location(0) u32 { return in.word; }` });
      const compilation = await module.getCompilationInfo();
      const diagnostic = { label: buffer.label, usage: buffer.usage, size: buffer.size,
        totalMessages: compilation.messages.length, messages: compilation.messages.slice(0, 32).map(message => ({
          type: message.type, message: message.message.slice(0, 4096), lineNum: message.lineNum,
          linePos: message.linePos, offset: message.offset, length: message.length,
        })), truncated: compilation.messages.length > 32 || compilation.messages.some(message => message.message.length > 4096) };
      receipt.shaderCompilations.push(diagnostic);
      helpers.require(!diagnostic.truncated, 'shader compilation diagnostics bound exceeded');
      helpers.require(!compilation.messages.some(message => message.type === 'error'), 'control shader compilation failed');
      const pipeline = device.createRenderPipeline({ layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: uniform ? [] : [{ arrayStride: 4, stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32' }] }] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32uint' }] }, primitive: { topology: 'point-list' } });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(pipeline);
      if (uniform) pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer } }] }));
      else pass.setVertexBuffer(0, buffer);
      pass.draw(words); pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: stage, bytesPerRow: 256 }, { width: words, height: 1 });
      device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
      await stage.mapAsync(GPUMapMode.READ);
      try { return new Uint8Array(stage.getMappedRange(), 0, buffer.size).slice(); }
      finally { stage.unmap(); }
    },
    match(actual, expected) {
      helpers.require(actual.length === expected.length, 'GPU/readback length mismatch');
      for (let i = 0; i < actual.length; i++) helpers.require(actual[i] === expected[i], `GPU byte mismatch at ${i}`);
    },
  };
  try {
    helpers.require(typeof installerSource === 'string' && installerSource.length < 65536, 'bounded recorder source required');
    const install = Function(`"use strict";return (${installerSource});`)();
    const adapter = await navigator.gpu?.requestAdapter(); helpers.require(adapter, 'WebGPU adapter unavailable');
    device = await adapter.requestDevice();
    const info = adapter.info;
    receipt.adapter = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null;
    device.addEventListener('uncapturederror', function error(event) {
      const message = String(event.error).slice(0, 4096);
      if (receipt.gpuEvents.length >= 32) { if (!failures.includes('GPU event prefix exhausted')) failures.push('GPU event prefix exhausted'); return; }
      receipt.gpuEvents.push({ kind: 'uncaptured', message });
      failures.push(`uncaptured GPU error: ${message}`); console.error('GPU_UNCAPTURED_ERROR', message);
    });
    lost = device.lost.then(function loss(info) {
      receipt.gpuEvents.push({ kind: 'device-lost', reason: info.reason, message: info.message, ending });
      receipt.deviceLossCompletion = !ending || info.reason !== 'destroyed'
        ? 'observed-unexpected-loss' : 'owned-destruction-observed';
      if (!ending || info.reason !== 'destroyed') { failures.push(`GPU device lost: ${info.message}`); console.error('GPU_DEVICE_LOST', info.message); }
    });
    receipt.deviceLossCompletion = 'pending';
    device.pushErrorScope('validation');
    try {
      recorder = install();
      const live = [], fill = { device, partitions: [] }, text = { device, instanceCount: 1 };
      const renderer = { device: { getDevice() { return device; } }, overlays: { symbolic: { fillPipeline: fill, textPipeline: text } } };
      const inputs = {
        make(label, size) {
          const buffer = helpers.own(device.createBuffer({ label, size, usage: label.endsWith('camera') ? 72 : 40 }));
          const words = new Uint32Array(size / 4);
          for (let i = 0; i < words.length; i++) words[i] = (0x80000000 + i * 0x1020304 + live.length) >>> 0;
          device.queue.writeBuffer(buffer, 0, new Float32Array(words.buffer));
          live.push({ buffer, label, declaredInputBytes: new Uint8Array(words.buffer).slice() }); return buffer;
        },
      };
      // A real replacement: dead previous vertices must never authorize the new buffer.
      const retired = inputs.make('symbolic-fill-vbuf', 28); retired.destroy(); live.pop();
      const vertexBuffer = inputs.make('symbolic-fill-vbuf', 28);
      const uniformBuffer = inputs.make('symbolic-fill-partition-camera', 160);
      fill.partitions.push({ vertexBuffer, uniformBuffer, vertexCount: 1 });
      text.cornerBuffer = inputs.make('symbolic-text-corner', 16);
      text.uniformBuffer = inputs.make('symbolic-text-camera', 208);
      text.instanceBuffer = inputs.make('symbolic-text-instances', 108);
      text.rteDeltaBuffer = inputs.make('symbolic-text-rte-deltas', 32);
      // Exact TypedArray element ranges, ArrayBuffer/DataView byte ranges and overlaps.
      const mutable = new Uint32Array([9, 0x7fc12345, 0x80000000, 13, 17]);
      device.queue.writeBuffer(vertexBuffer, 4, mutable.subarray(1, 4), 1, 1);
      device.queue.writeBuffer(uniformBuffer, 8, mutable.buffer, 4, 8);
      device.queue.writeBuffer(text.instanceBuffer, 12, new DataView(mutable.buffer, 4, 12), 4, 8);
      device.queue.writeBuffer(text.rteDeltaBuffer, 4, new Uint32Array([91, 92]));
      // Independent destination plan uses literal payloads, never recorder/readback output.
      for (const [label, offset, words] of [
        ['symbolic-fill-vbuf', 4, [0x80000000]],
        ['symbolic-fill-partition-camera', 8, [0x7fc12345, 0x80000000]],
        ['symbolic-text-instances', 12, [0x80000000, 13]],
        ['symbolic-text-rte-deltas', 4, [91, 92]],
      ]) live.find(item => item.label === label).declaredInputBytes.set(new Uint8Array(new Uint32Array(words).buffer), offset);
      receipt.sourceMutation = { before: Array.from(mutable), mutationValue: 0x55555555 };
      mutable.fill(0x55555555); // WebGPU and recorder must already own the written data.
      receipt.sourceMutation.after = Array.from(mutable);
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
      const context = canvas.getContext('2d'); helpers.require(context, 'atlas 2D context unavailable');
      context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
      text.atlas = { canvas, atlasSize: 1024, getVersion() { return 1; } }; text.uploadedAtlasVersion = 1;
      text.atlasTexture = helpers.own(device.createTexture({ label: 'symbolic-text-atlas', size: [1024, 1024],
        format: 'rgba8unorm', usage: 22 }));
      device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: text.atlasTexture }, { width: 1024, height: 1024 });
      await device.queue.onSubmittedWorkDone();
      const frozen = recorder.freeze(renderer); helpers.require(frozen.status === 'frozen', frozen.reason);
      helpers.require(frozen.buffers.length === live.length, 'live buffer census mismatch');
      for (const [index, item] of live.entries()) {
        const expected = frozen.buffers[index]; helpers.require(expected.label === item.label, 'creation-order ownership mismatch');
        const raw = await helpers.read(item.buffer); helpers.match(raw, expected.bytes);
        helpers.match(raw, item.declaredInputBytes);
        helpers.require(new Set(raw).size > 1, 'independent payload diversity missing');
        // Real readback rejects an independently changed expected byte; no fake GPU response.
        const changed = expected.bytes.slice(); changed[0] ^= 1;
        let mutationRejected = false; try { helpers.match(raw, changed); } catch (error) { mutationRejected = /GPU byte mismatch/.test(String(error)); }
        helpers.require(mutationRejected, 'negative byte mutation was not rejected');
        receipt.controls.push({ label: item.label, usage: item.buffer.usage, size: item.buffer.size,
          rawBytes: Array.from(raw), capturedBytes: Array.from(expected.bytes),
          declaredInputBytes: Array.from(item.declaredInputBytes), mutationRejected });
      }
      helpers.require(recorder.status().status === 'frozen', 'recorder invalidated during GPU readback');
      helpers.disposeRecorder('active-buffers'); recorder = install();
      const corner = helpers.own(device.createBuffer({ label: 'symbolic-text-corner', size: 16, usage: 40 }));
      const camera = helpers.own(device.createBuffer({ label: 'symbolic-text-camera', size: 208, usage: 72 }));
      device.queue.writeBuffer(corner, 0, new Uint32Array([0, 1, 2, 3]));
      const empty = { device, instanceCount: 0, cornerBuffer: corner, uniformBuffer: camera, instanceBuffer: null, rteDeltaBuffer: null };
      const frozenEmpty = recorder.freeze({ device: renderer.device, overlays: { symbolic: {
        fillPipeline: { device, partitions: [] }, textPipeline: empty } } });
      helpers.require(frozenEmpty.status === 'frozen' && frozenEmpty.buffers.length === 2
        && frozenEmpty.buffers.every(item => !item.active && item.bytes === null), 'initialized empty text incorrectly claims uploads');
      receipt.emptyText = { census: frozenEmpty.census, buffers: frozenEmpty.buffers };
      helpers.disposeRecorder('empty-text');
      await device.queue.onSubmittedWorkDone();
    } catch (error) { failures.push(String(error)); }
    finally {
      try {
        const error = await device.popErrorScope();
        if (error) { failures.push(`GPU validation: ${error.message}`); console.error('GPU_VALIDATION_ERROR', error.message); }
      } catch (error) { failures.push(`GPU scope failed: ${String(error)}`); }
    }
    if (receipt.deviceLossCompletion === 'pending') receipt.deviceLossCompletion = 'not-observed-before-cleanup';
    // Intentional cleanup is explicit; any pre-cleanup loss still refuses.
    ending = true; device.destroy(); await lost;
  } catch (error) { failures.push(String(error)); }
  finally {
    try { helpers.disposeRecorder('finally'); }
    catch (error) { cleanupFailures.push(`recorder cleanup: ${String(error)}`); }
    for (const resource of resources) {
      try { resource.destroy(); } catch (error) { cleanupFailures.push(`resource cleanup: ${String(error)}`); }
    }
    if (device) {
      ending = true;
      try { device.destroy(); if (lost) await lost; }
      catch (error) { cleanupFailures.push(`device cleanup: ${String(error)}`); }
    }
    if (receipt.recorderDisposals.some(item => item.status !== 'disposed')) cleanupFailures.push('recorder restoration refused');
    receipt.cleanupFailures = cleanupFailures; failures.push(...cleanupFailures);
    receipt.cleanup = cleanupFailures.length ? 'refused' : 'complete';
  }
  receipt.failures = failures;
  receipt.status = failures.length ? 'refused' : 'observed-gpu-upload-input-identity';
  return receipt;
}
