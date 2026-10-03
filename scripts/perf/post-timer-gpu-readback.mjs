/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 plain serializable factory; diagnostic inputs only, no write observer.
export function createPostTimerGpuReadback(device) {
  const limits = device.limits, cap = 32 * 1024 * 1024;
  const chunkCap = Math.min(4 * 1024 * 1024, limits.maxBufferSize);
  const maxWidth = Math.min(2048, limits.maxTextureDimension2D, Math.floor(chunkCap / 256) * 64);
  const receipt = { status: 'idle', operations: 0, tiles: 0, shaderDiagnostics: [], cleanupFailures: [] };
  let busy = false, closed = false, diagnosticBytes = 0;
  device.lost.then(info => { if (!closed) { receipt.status = 'refused'; receipt.deviceLoss = { reason: info.reason, message: boundedText(info.message) }; } });
  function require(ok, reason) { if (!ok) throw new Error('GPU readback refused: ' + reason); }
  function boundedText(value) {
    const bytes = new TextEncoder().encode(String(value));
    if (bytes.length > 4096) receipt.prefixRefusal ??= 'error message UTF8 prefix';
    return new TextDecoder().decode(bytes.subarray(0, 4096), { stream: true });
  }
  function cleanupFailure(error) {
    if (receipt.cleanupFailures.length >= 32) receipt.prefixRefusal ??= 'cleanup error ledger prefix';
    else receipt.cleanupFailures.push(boundedText(error));
  }
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  require(integer(chunkCap) && chunkCap >= 256 && integer(maxWidth) && maxWidth > 0, 'adapter limits');
  function rows(width, height) {
    const pitch = Math.ceil(width * 4 / 256) * 256;
    require(integer(width) && width > 0 && width <= maxWidth && integer(height) && height > 0
      && height <= limits.maxTextureDimension2D && pitch * height <= chunkCap, 'tile size');
    return { width, height, pitch, stagingBytes: pitch * height };
  }
  function bufferPlan(source, offset = 0, length = source.size - offset) {
    require(source.usage === 40 || source.usage === 72, 'original buffer usage40/72 required');
    require(integer(source.size) && source.size <= limits.maxBufferSize && source.mapState === 'unmapped', 'source buffer state/size');
    require(integer(offset) && integer(length) && length > 0 && length <= cap && offset <= source.size
      && length <= source.size - offset && offset % 4 === 0 && length % 4 === 0, 'word range');
    const uniform = source.usage === 72, tiles = [];
    if (uniform) require(source.size % 16 === 0 && integer(limits.minUniformBufferOffsetAlignment)
      && limits.minUniformBufferOffsetAlignment > 0 && limits.minUniformBufferOffsetAlignment % 16 === 0
      && limits.maxUniformBufferBindingSize >= 16, 'uniform limits/alignment');
    for (let consumed = 0; consumed < length;) {
      const position = offset + consumed;
      const bindOffset = uniform ? Math.floor(position / limits.minUniformBufferOffsetAlignment) * limits.minUniformBufferOffsetAlignment : position;
      const prefix = position - bindOffset;
      const available = uniform ? Math.floor(Math.min(limits.maxUniformBufferBindingSize, source.size - bindOffset) / 16) * 16 - prefix : length - consumed;
      require(available > 0, 'uniform window');
      let bytes = Math.min(length - consumed, available);
      const width = Math.min(maxWidth, bytes / 4), pitch = Math.ceil(width * 4 / 256) * 256;
      bytes = Math.min(bytes, width * Math.min(limits.maxTextureDimension2D, Math.floor(chunkCap / pitch)) * 4);
      const layout = rows(width, Math.ceil(bytes / 4 / width));
      tiles.push({ ...layout, bytes, consumed, bindOffset, prefixWords: prefix / 4,
        bindingSize: uniform ? Math.ceil((prefix + bytes) / 16) * 16 : bytes });
      require(tiles.length <= 2048, 'tile count'); consumed += bytes;
    }
    return { uniform, offset, length, tiles };
  }
  function atlasPlan(source, region = {}) {
    require(source.usage === 22 && source.format === 'rgba8unorm' && source.dimension === '2d'
      && source.sampleCount === 1 && source.depthOrArrayLayers === 1 && source.mipLevelCount === 1, 'atlas original usage22/RGBA8 shape');
    const { x = 0, y = 0, width = source.width - x, height = source.height - y } = region;
    require([source.width, source.height, x, y, width, height].every(integer) && width > 0 && height > 0
      && x <= source.width && width <= source.width - x && y <= source.height && height <= source.height - y
      && source.width <= limits.maxTextureDimension2D && source.height <= limits.maxTextureDimension2D
      && width * height * 4 <= cap, 'atlas rectangle');
    const tiles = [];
    for (let dx = 0; dx < width;) {
      const w = Math.min(maxWidth, width - dx), pitch = Math.ceil(w * 4 / 256) * 256;
      const hMax = Math.min(limits.maxTextureDimension2D, Math.floor(chunkCap / pitch));
      for (let dy = 0; dy < height;) {
        const h = Math.min(hMax, height - dy); tiles.push({ ...rows(w, h), x: x + dx, y: y + dy, dx, dy }); dy += h;
        require(tiles.length <= 2048, 'atlas tile count');
      }
      dx += w;
    }
    return { width, height, length: width * height * 4, tiles };
  }
  async function shader(code) {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    require(receipt.shaderDiagnostics.length < 2048, 'shader diagnostic count');
    const diagnostic = { totalMessages: info.messages.length, messages: info.messages.slice(0, 32).map(m => ({
      type: m.type, message: boundedText(m.message), lineNum: m.lineNum, linePos: m.linePos, offset: m.offset, length: m.length })) };
    const bytes = new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength;
    require(diagnosticBytes + bytes <= 128 * 1024, 'total shader diagnostic budget');
    diagnosticBytes += bytes; receipt.shaderDiagnostics.push(diagnostic);
    require(info.messages.length <= 32 && !receipt.prefixRefusal, 'shader diagnostic prefix');
    require(!info.messages.some(m => m.type === 'error'), 'shader compilation'); return module;
  }
  async function tile(source, layout, uniform, atlas, sink) {
    require(!receipt.cleanupFailures.length && !receipt.prefixRefusal, 'prior cleanup/diagnostic refusal');
    let target, staging, mapped = false;
    try {
      target = device.createTexture({ label: 'post-timer-owned-target', size: [layout.width, layout.height],
        format: atlas ? 'rgba8unorm' : 'r32uint', usage: 17 });
      staging = device.createBuffer({ label: 'post-timer-owned-stage', size: layout.stagingBytes, usage: 9 });
      const bufferCode = `${uniform ? '@group(0) @binding(0) var<uniform> words: array<vec4<u32>, ' + layout.bindingSize / 16 + '>;' : ''}
        struct Out { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) word: u32 }
        @vertex fn vs(@builtin(vertex_index) i:u32${uniform ? '' : ', @location(0) word:u32'}) -> Out {
          var o:Out; o.pos=vec4<f32>((f32(i%${layout.width}u)+0.5)/${layout.width}.0*2.0-1.0,
            1.0-(f32(i/${layout.width}u)+0.5)/${layout.height}.0*2.0,0.0,1.0);
          o.word=${uniform ? 'words[(i+' + layout.prefixWords + 'u)/4u][(i+' + layout.prefixWords + 'u)%4u]' : 'word'};return o;
        } @fragment fn fs(o:Out)->@location(0) u32{return o.word;}`;
      const atlasCode = `@group(0) @binding(0) var source:texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
          let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));return vec4<f32>(p[i],0.0,1.0);
        } @fragment fn fs(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
          return textureLoad(source,vec2<i32>(p.xy)+vec2<i32>(${layout.x},${layout.y}),0);}`;
      const module = await shader(atlas ? atlasCode : bufferCode);
      const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs',
        buffers: atlas || uniform ? [] : [{ arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32' }] }] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: atlas ? 'rgba8unorm' : 'r32uint' }] },
        primitive: { topology: atlas ? 'triangle-list' : 'point-list' } });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(pipeline);
      if (atlas || uniform) pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0,
        resource: atlas ? source.createView({ baseMipLevel: 0, mipLevelCount: 1 }) : { buffer: source, offset: layout.bindOffset, size: layout.bindingSize } }] }));
      else pass.setVertexBuffer(0, source, layout.bindOffset, layout.bytes);
      pass.draw(atlas ? 3 : layout.bytes / 4); pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: layout.pitch }, { width: layout.width, height: layout.height });
      device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
      await staging.mapAsync(1); mapped = true;
      sink(new Uint8Array(staging.getMappedRange())); receipt.tiles++;
    } finally {
      if (mapped) { try { staging.unmap(); } catch (error) { cleanupFailure(error); } }
      for (const resource of [staging, target]) if (resource) {
        try { resource.destroy(); } catch (error) { cleanupFailure(error); }
      }
    }
  }
  async function perform(plan, work) {
    require(!busy && !closed && !receipt.deviceLoss && receipt.operations < 64, 'reader lifetime/concurrency');
    busy = true; receipt.status = 'reading'; receipt.operations++;
    let output, failed, scoped = false;
    try { device.pushErrorScope('validation'); scoped = true; output = new Uint8Array(plan.length); await work(output); }
    catch (error) { failed = error; }
    finally {
      try { if (scoped) { const error = await device.popErrorScope(); if (error) failed ??= new Error('GPU validation: ' + error.message); } }
      catch (error) { failed ??= error; }
      busy = false;
    }
    if (receipt.deviceLoss) failed ??= new Error('GPU device lost during readback: ' + receipt.deviceLoss.message);
    if (receipt.cleanupFailures.length || receipt.prefixRefusal) failed ??= new Error('Owned readback cleanup refused');
    if (failed) { receipt.status = 'refused'; closed = true; throw failed; }
    receipt.status = 'complete'; return output;
  }
  return {
    planBuffer: bufferPlan, planAtlas: atlasPlan,
    async readBuffer(source, offset = 0, length = source.size - offset) {
      const plan = bufferPlan(source, offset, length);
      return perform(plan, async output => {
        for (const layout of plan.tiles) await tile(source, layout, plan.uniform, false, bytes => {
          for (let row = 0, copied = 0; copied < layout.bytes; row++) {
            const size = Math.min(layout.width * 4, layout.bytes - copied);
            output.set(bytes.subarray(row * layout.pitch, row * layout.pitch + size), layout.consumed + copied); copied += size;
          }
        });
      });
    },
    async readAtlas(source, region = {}) {
      const plan = atlasPlan(source, region);
      return perform(plan, async output => {
        for (const layout of plan.tiles) await tile(source, layout, false, true, bytes => {
          for (let row = 0; row < layout.height; row++) output.set(bytes.subarray(row * layout.pitch, row * layout.pitch + layout.width * 4),
            ((layout.dy + row) * plan.width + layout.dx) * 4);
        });
      });
    },
    status() { return structuredClone(receipt); },
    close() { require(!busy, 'active read'); closed = true; return structuredClone(receipt); },
  };
}
