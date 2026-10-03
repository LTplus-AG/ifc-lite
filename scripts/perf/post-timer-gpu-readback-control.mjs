/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 serializable standalone page control, not a comparator or viewer caller.
export async function postTimerGpuReadbackControl(factorySource) {
  const receipt = { status: 'started', scope: 'Standalone live buffer/atlas input bytes; no IFC/pixels/timing', controls: [], errors: [], cleanup: 'pending' };
  const owned = []; let device, reader, ending = false, loss;
  const boundedMessage = value => {
    const bytes = new TextEncoder().encode(String(value));
    if (bytes.length > 4096) receipt.errorPrefixRefused = true;
    return new TextDecoder().decode(bytes.subarray(0, 4096), { stream: true });
  };
  const error = value => {
    const diagnostic = { type: boundedMessage(value?.constructor?.name || typeof value), message: boundedMessage(value?.message ?? value) };
    if (receipt.errors.length < 64) receipt.errors.push(diagnostic);
    else receipt.errorPrefixRefused = true;
    console.error('READBACK_CONTROL_ERROR', diagnostic.type, String(value?.message ?? value));
  };
  const require = (ok, reason) => { if (!ok) throw new Error(reason); };
  const own = x => { owned.push(x); return x; };
  async function hash(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join(''); }
  async function verify(label, actual, expected, plan) {
    require(actual.length === expected.length && actual.every((n, i) => n === expected[i]), label + ' independent bytes differ');
    const changed = actual.slice(); changed[Math.floor(changed.length / 2)] ^= 1;
    const digest = await hash(actual), expectedDigest = await hash(expected);
    require(digest === expectedDigest && digest !== await hash(changed), label + ' hash mutation accepted');
    receipt.controls.push({ label, rawBytes: Array.from(actual), sha256: digest, expectedSha256: expectedDigest, mutationRejected: true, plan });
  }
  try {
    require(typeof factorySource === 'string' && factorySource.length < 65536, 'bounded factory source');
    const factory = Function('"use strict";return (' + factorySource + ');')();
    const adapter = await navigator.gpu?.requestAdapter(); require(adapter, 'adapter unavailable');
    device = await adapter.requestDevice();
    receipt.deviceLimits = Object.fromEntries(['maxBufferSize', 'maxTextureDimension2D', 'maxUniformBufferBindingSize', 'minUniformBufferOffsetAlignment'].map(k => [k, device.limits[k]]));
    const info = adapter.info; receipt.adapter = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null;
    device.addEventListener('uncapturederror', e => { error(e.error); });
    loss = device.lost.then(info => { receipt.deviceLoss = { reason: info.reason, message: boundedMessage(info.message), ending }; if (!ending || info.reason !== 'destroyed') error('unexpected device loss'); });
    const nativeWrite = device.queue.writeBuffer, nativeCreate = device.createBuffer;
    reader = factory(device);
    for (const [label, usage, size, offset, length] of [
      ['vertex-multiple-rows', 40, 20032, 12, 20012],
      ['uniform-window-boundary', 72, device.limits.maxUniformBufferBindingSize + 512, 12, device.limits.maxUniformBufferBindingSize + 256],
    ]) {
      require(size <= 2 * 1024 * 1024 && size % 16 === 0, 'finite standalone source size');
      const buffer = own(device.createBuffer({ label, usage, size }));
      const words = new Uint32Array(size / 4);
      for (let i = 0; i < words.length; i++) words[i] = (0x80000000 + i * 0x1020304) >>> 0;
      const expected = new Uint8Array(words.buffer).slice(offset, offset + length);
      device.queue.writeBuffer(buffer, 0, words); words.fill(0x55555555);
      await verify(label, await reader.readBuffer(buffer, offset, length), expected, { ...reader.planBuffer(buffer, offset, length), source: { size: buffer.size, usage: buffer.usage } });
    }
    const width = 67, height = 35, pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = i % 256; pixels[i * 4 + 1] = (i * 37 + 19) % 256;
      pixels[i * 4 + 2] = (i * 71 + 5) % 256; pixels[i * 4 + 3] = (i * 13) % 256;
    }
    const atlas = own(device.createTexture({ label: 'independent-alpha-atlas', size: [width, height], format: 'rgba8unorm', usage: 22 }));
    device.queue.writeTexture({ texture: atlas }, pixels, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
    const source = { width: atlas.width, height: atlas.height, usage: atlas.usage, format: atlas.format,
      mipLevelCount: atlas.mipLevelCount, sampleCount: atlas.sampleCount, dimension: atlas.dimension, depthOrArrayLayers: atlas.depthOrArrayLayers };
    const expected = pixels.slice(); pixels.fill(85);
    await verify('atlas-all-channels-alpha', await reader.readAtlas(atlas), expected, { ...reader.planAtlas(atlas), source });
    const region = { x: 3, y: 2, width: 61, height: 31 }, sub = new Uint8Array(region.width * region.height * 4);
    for (let row = 0; row < region.height; row++) sub.set(expected.subarray(((region.y + row) * width + region.x) * 4,
      ((region.y + row) * width + region.x + region.width) * 4), row * region.width * 4);
    await verify('atlas-subrectangle', await reader.readAtlas(atlas, region), sub, { ...reader.planAtlas(atlas, region), source });
    const wrongBuffer = own(device.createBuffer({ size: 16, usage: 44 }));
    const wrongAtlas = own(device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 23 }));
    receipt.negativeSources = { buffer: { size: wrongBuffer.size, usage: wrongBuffer.usage },
      atlas: { width: wrongAtlas.width, height: wrongAtlas.height, usage: wrongAtlas.usage, format: wrongAtlas.format,
        mipLevelCount: wrongAtlas.mipLevelCount, sampleCount: wrongAtlas.sampleCount, dimension: wrongAtlas.dimension, depthOrArrayLayers: wrongAtlas.depthOrArrayLayers } };
    for (const [label, operation] of [['buffer', () => reader.readBuffer(wrongBuffer)], ['atlas', () => reader.readAtlas(wrongAtlas)]]) {
      let rejected = false; try { await operation(); } catch (error) { rejected = /original.*usage/.test(String(error)); }
      require(rejected, label + ' wrong usage accepted');
    }
    require(device.queue.writeBuffer === nativeWrite && device.createBuffer === nativeCreate, 'native methods changed');
    receipt.nativeMethodsUnchanged = true; receipt.wrongUsageRejected = true; receipt.reader = reader.close(); reader = null;
    require(receipt.reader.status === 'complete' && !receipt.reader.prefixRefusal && !receipt.reader.cleanupFailures.length, 'reader completion refused');
  } catch (failure) { error(failure); }
  finally {
    if (reader) { try { receipt.reader = reader.close(); } catch (failure) { error(failure); } }
    for (const resource of owned) { try { resource.destroy(); } catch (failure) { error(failure); } }
    if (device) { ending = true; try { device.destroy(); await loss; } catch (failure) { error(failure); } }
    receipt.cleanup = receipt.errors.length || receipt.errorPrefixRefused ? 'refused' : 'complete';
  }
  receipt.status = receipt.errors.length || receipt.errorPrefixRefused ? 'refused' : 'observed-pending-outer-qualification'; return receipt;
}
