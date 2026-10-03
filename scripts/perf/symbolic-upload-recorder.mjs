/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 PROTOTYPE ONLY. No comparator integration or eligibility change.
// Self-contained for page.addInitScript / isolated Function.toString execution.
export function installSymbolicUploadRecorder(limits = {}) {
  const cap = { buffers: 1024, bytes: 32 * 1024 ** 2, writes: 10000, copies: 64, ...limits };
  for (const value of Object.values(cap)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid recorder bound');
  }
  const labels = new Set(['symbolic-fill-vbuf', 'symbolic-fill-partition-camera',
    'symbolic-text-corner', 'symbolic-text-camera', 'symbolic-text-instances', 'symbolic-text-rte-deltas']);
  const records = new Map(), atlasCopies = new Map(), patches = [];
  let reason = null, phase = 'recording', allocated = 0, created = 0, retired = 0, writes = 0, copies = 0;
  const helpers = {
    refuse(message) { reason ??= String(message).slice(0, 512); },
    integer(value) { return Number.isSafeInteger(value) && value >= 0; },
    source(data, offset = 0, size, maximum) {
      const view = ArrayBuffer.isView(data);
      const buffer = view ? data.buffer : data;
      if (!(buffer instanceof ArrayBuffer)) throw new Error('shared/unknown source buffer');
      const length = view ? data.byteLength : buffer.byteLength;
      const unit = view && !(data instanceof DataView) ? data.BYTES_PER_ELEMENT : 1;
      if (!helpers.integer(unit) || unit < 1 || !helpers.integer(offset)
        || (size !== undefined && !helpers.integer(size))) throw new Error('unknown source units');
      const start = offset * unit, count = size === undefined ? length - start : size * unit;
      if (!helpers.integer(start) || !helpers.integer(count) || start + count > length || count % 4 || count > maximum) {
        throw new Error('source range/alignment');
      }
      return new Uint8Array(buffer, (view ? data.byteOffset : 0) + start, count).slice();
    },
    patch(prototype, key, method) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor || typeof descriptor.value !== 'function') throw new Error(`missing native ${key}`);
      patches.push({ prototype, key, descriptor, wrapper: method });
      Object.defineProperty(prototype, key, { ...descriptor, value: method });
      return descriptor.value;
    },
    release(record) {
      if (record.bytes) allocated -= record.size;
      record.bytes = null; record.coverage = null;
    },
    status() {
      return { status: reason ? 'refused' : phase, reason, created, retired, writes, copies,
        retainedShadowBytes: allocated, bounds: { ...cap } };
    },
  };
  let originalCreate, originalWrite, originalDestroy, originalCopy;
  const methods = {
    createBuffer(...args) {
      let buffer;
      try { buffer = Reflect.apply(originalCreate, this, args); }
      catch (error) { helpers.refuse(`native createBuffer rejected: ${String(error)}`); throw error; }
      try {
        const descriptor = args[0];
        if (!String(buffer.label).startsWith('symbolic-')) return buffer;
        if (phase !== 'recording') { helpers.refuse('symbolic creation after freeze/cancel'); return buffer; }
        if (!labels.has(buffer.label)) throw new Error('unknown symbolic label');
        if (reason) return buffer;
        created++;
        if (created > cap.buffers || !helpers.integer(buffer.size) || buffer.size === 0
          || buffer.size % 4 || allocated + buffer.size > cap.bytes) throw new Error('symbolic buffer bound/size');
        if (descriptor.mappedAtCreation || descriptor.size !== buffer.size || descriptor.usage !== buffer.usage) {
          throw new Error('mapped/unknown buffer descriptor');
        }
        const expectedUsage = buffer.label.endsWith('camera') ? 72 : 40; // UNIFORM/VERTEX | COPY_DST
        if (buffer.usage !== expectedUsage) throw new Error('unknown symbolic buffer usage');
        records.set(buffer, { buffer, device: this, queue: this.queue, label: buffer.label,
          size: buffer.size, usage: buffer.usage, bytes: new Uint8Array(buffer.size),
          coverage: new Uint8Array(buffer.size), destroyed: false });
        allocated += buffer.size;
      } catch (error) { helpers.refuse(`capture createBuffer: ${String(error)}`); }
      return buffer;
    },
    writeBuffer(...args) {
      const [buffer, destination, data, sourceOffset, size] = args;
      const record = records.get(buffer);
      let bytes;
      try {
        if (record || String(buffer?.label).startsWith('symbolic-')) {
          if (phase !== 'recording') throw new Error('symbolic write after freeze/cancel');
          if (!record || record.destroyed || record.queue !== this) throw new Error('unknown/destroyed/foreign symbolic write');
          if (++writes > cap.writes) throw new Error('symbolic write bound');
          if (!reason) {
            if (!helpers.integer(destination) || destination % 4) throw new Error('destination alignment');
            bytes = helpers.source(data, sourceOffset, size, record.size - destination);
            if (destination + bytes.length > record.size) throw new Error('destination range');
          }
        }
      } catch (error) { helpers.refuse(`capture writeBuffer: ${String(error)}`); }
      let result;
      try { result = Reflect.apply(originalWrite, this, args); }
      catch (error) { helpers.refuse(`native writeBuffer rejected: ${String(error)}`); throw error; }
      if (bytes && !reason) {
        record.bytes.set(bytes, destination); record.coverage.fill(1, destination, destination + bytes.length);
      }
      return result;
    },
    destroy(...args) {
      let result;
      try { result = Reflect.apply(originalDestroy, this, args); }
      catch (error) { helpers.refuse(`native destroy rejected: ${String(error)}`); throw error; }
      const record = records.get(this);
      if (record && !record.destroyed) { helpers.release(record); record.destroyed = true; retired++; }
      return result;
    },
    copyExternalImageToTexture(...args) {
      let result;
      try { result = Reflect.apply(originalCopy, this, args); }
      catch (error) { helpers.refuse(`native atlas copy rejected: ${String(error)}`); throw error; }
      try {
        const [source, destination, extent] = args;
        if (destination.texture?.label !== 'symbolic-text-atlas') return result;
        if (phase !== 'recording' || ++copies > cap.copies) throw new Error('atlas copy phase/bound');
        if (source.flipY !== false || source.origin !== undefined || destination.origin !== undefined
          || destination.mipLevel !== undefined || destination.aspect !== undefined
          || destination.colorSpace !== undefined || destination.premultipliedAlpha !== undefined
          || !helpers.integer(extent.width) || !helpers.integer(extent.height)
          || (extent.depthOrArrayLayers !== undefined && extent.depthOrArrayLayers !== 1)) {
          throw new Error('unknown atlas copy parameters');
        }
        atlasCopies.set(destination.texture, { source: source.source, queue: this,
          width: extent.width, height: extent.height, flipY: source.flipY });
      } catch (error) { helpers.refuse(`capture atlas: ${String(error)}`); }
      return result;
    },
  };
  try {
    originalCreate = helpers.patch(GPUDevice.prototype, 'createBuffer', methods.createBuffer);
    originalWrite = helpers.patch(GPUQueue.prototype, 'writeBuffer', methods.writeBuffer);
    originalDestroy = helpers.patch(GPUBuffer.prototype, 'destroy', methods.destroy);
    originalCopy = helpers.patch(GPUQueue.prototype, 'copyExternalImageToTexture', methods.copyExternalImageToTexture);
  } catch (error) {
    for (const patch of patches.reverse()) Object.defineProperty(patch.prototype, patch.key, patch.descriptor);
    throw error;
  }
  return {
    status() { return helpers.status(); },
    cancel() {
      helpers.refuse('recorder cancelled'); phase = 'cancelled';
      for (const record of records.values()) helpers.release(record);
      atlasCopies.clear();
    },
    freeze(renderer) {
      if (phase !== 'recording') helpers.refuse('freeze is single-use');
      phase = 'frozen';
      const buffers = [], expected = new Map(); let atlas = null, census = null;
      try {
        const device = renderer.device.getDevice();
        const symbolic = renderer.overlays.symbolic;
        const fill = symbolic.fillPipeline, text = symbolic.textPipeline;
        if (!fill || !text || fill.device !== device || text.device !== device) throw new Error('pipeline/device ownership');
        if (!Array.isArray(fill.partitions) || fill.partitions.length > cap.buffers
          || !helpers.integer(text.instanceCount)) throw new Error('unknown pipeline census');
        const add = (buffer, label, active = true) => {
          if (!buffer || expected.has(buffer)) throw new Error('missing/duplicate pipeline buffer');
          expected.set(buffer, { label, active });
        };
        for (const partition of fill.partitions) {
          if (!helpers.integer(partition.vertexCount) || partition.vertexBuffer.size !== partition.vertexCount * 28
            || partition.uniformBuffer.size !== 160) {
            throw new Error('fill count/stride/uniform size');
          }
          add(partition.vertexBuffer, 'symbolic-fill-vbuf'); add(partition.uniformBuffer, 'symbolic-fill-partition-camera');
        }
        if (text.instanceCount > 0) {
          if (text.instanceBuffer.size !== text.instanceCount * 108 || text.rteDeltaBuffer.size !== text.instanceCount * 32
            || text.uniformBuffer.size !== 208 || text.cornerBuffer.size !== 16) throw new Error('text count/stride');
          add(text.instanceBuffer, 'symbolic-text-instances'); add(text.rteDeltaBuffer, 'symbolic-text-rte-deltas');
          add(text.uniformBuffer, 'symbolic-text-camera'); add(text.cornerBuffer, 'symbolic-text-corner');
          const observed = atlasCopies.get(text.atlasTexture), current = text.atlas.getVersion();
          if (!observed || observed.queue !== device.queue || observed.source !== text.atlas.canvas
            || current !== text.uploadedAtlasVersion || observed.width !== text.atlas.atlasSize
            || observed.height !== text.atlas.atlasSize || text.atlasTexture.width !== observed.width
            || text.atlasTexture.height !== observed.height || text.atlasTexture.format !== 'rgba8unorm'
            || text.atlasTexture.usage !== 22) throw new Error('atlas source/upload version ownership');
          atlas = { currentVersion: current, uploadedVersion: text.uploadedAtlasVersion,
            width: observed.width, height: observed.height, flipY: observed.flipY,
            witness: 'source canvas pointer/version/parameters ONLY; no canvas pixels or GPU texels' };
        } else {
          // init()/upload([]) owns static corner/camera allocations, but renders no glyphs.
          if (text.instanceBuffer != null || text.rteDeltaBuffer != null
            || Boolean(text.cornerBuffer) !== Boolean(text.uniformBuffer)) throw new Error('unknown inactive text shape');
          if (text.cornerBuffer) {
            if (text.cornerBuffer.size !== 16 || text.uniformBuffer.size !== 208) throw new Error('inactive text sizes');
            add(text.cornerBuffer, 'symbolic-text-corner', false); add(text.uniformBuffer, 'symbolic-text-camera', false);
          }
        }
        census = { fillPartitions: fill.partitions.length, textInstances: text.instanceCount };
        for (const record of records.values()) {
          if (record.destroyed) continue;
          const authorized = expected.get(record.buffer);
          if (record.device !== device || record.queue !== device.queue || record.buffer.label !== record.label
            || authorized?.label !== record.label) {
            throw new Error('unowned/unlisted live symbolic buffer');
          }
          const complete = Boolean(record.coverage && !record.coverage.includes(0));
          if (authorized.active && !complete) throw new Error('incomplete symbolic byte coverage');
          buffers.push({ label: record.label, size: record.size, usage: record.usage, active: authorized.active,
            completeObservedCoverage: complete, bytes: authorized.active ? record.bytes.slice() : null });
          expected.delete(record.buffer);
        }
        if (expected.size) throw new Error('uncaptured live pipeline buffer');
      } catch (error) { helpers.refuse(`freeze: ${String(error)}`); }
      // The post-timer clone is independent of future writes/destruction; teardown cannot enter it.
      for (const record of records.values()) helpers.release(record);
      return { ...helpers.status(), buffers: reason ? [] : buffers, atlas: reason ? null : atlas,
        census: reason ? null : census,
        scope: 'instrumented symbolic GPU upload inputs; not GPU output/pixels/full appearance' };
    },
    dispose() {
      phase = 'disposed';
      for (const patch of patches) {
        if (patch.prototype[patch.key] === patch.wrapper) Object.defineProperty(patch.prototype, patch.key, patch.descriptor);
        else helpers.refuse('native prototype replaced by another observer');
      }
      records.clear(); atlasCopies.clear(); allocated = 0;
      return helpers.status();
    },
  };
}
