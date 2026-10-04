/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Explicit synthetic wire-layout compatibility fixture, NOT Rust/model output.
// The production decoder alone creates its decoded objects and template views.
export function triangleCompatibilityBytes(version = 3, owners = [42, 43]) {
  if (![1, 2, 3].includes(version)) throw new RangeError('Unsupported fixture version');
  const stride = version === 1 ? 88 : version === 2 ? 92 : 100;
  const dataOffset = 80 + owners.length * stride, buffer = new ArrayBuffer(dataOffset + 84);
  const view = new DataView(buffer);
  new Uint32Array(buffer, 0, 8).set([0x49464e53, version, 1, owners.length, 9, 9, 3, version === 1 ? 0 : stride]);
  new Uint32Array(buffer, 32, 6).set([0, 9, 0, 9, 0, 3]);
  [2, -3, 5].forEach((value, n) => view.setFloat64(56 + n * 8, value, true));
  const transforms = [
    [1, 0, 0, 7, 0, 1, 0, 11, 0, 0, 1, 13, 0, 0, 0, 1],
    [0, -1, 0, 5, 1, 0, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1],
  ];
  for (const [n, owner] of owners.entries()) {
    const base = 80 + n * stride;
    view.setUint32(base, 0, true); view.setUint32(base + 4, owner, true);
    [0.25, 0.5, 0.75, 1].forEach((value, k) => view.setFloat32(base + 8 + k * 4, value, true));
    transforms[n % 2].forEach((value, k) => view.setFloat32(base + 24 + k * 4, value, true));
    if (stride >= 92) view.setUint32(base + 88, 500 + n, true);
    if (stride === 100) { view.setFloat32(base + 92, 0.25, true); view.setFloat32(base + 96, 0.75, true); }
  }
  new Float32Array(buffer, dataOffset, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(buffer, dataOffset + 36, 9).set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  new Uint32Array(buffer, dataOffset + 72, 3).set([0, 1, 2]);
  return buffer;
}

// Sized GPU byte allocation/copy/destruction adapter only. It never creates
// templates, matrices, anchors, meshes or owner entries. Those are production.
export function boundedGpuBytes() {
  const records = new Map(), all = [], writes = [];
  let liveBytes = 0, nextWriteFailure = null;
  const device = {
    limits: { maxBufferSize: 1024 ** 2, maxStorageBufferBindingSize: 1024 ** 2 },
    createBuffer(descriptor) {
      if (this !== device || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0
        || descriptor.size % 4 || all.length >= 128 || liveBytes + descriptor.size > 1024 ** 2) {
        throw new RangeError('GPU test allocation ownership/size cap');
      }
      const record = { bytes: new Uint8Array(descriptor.size), destroyed: false, descriptor: { ...descriptor } };
      const buffer = { size: descriptor.size, destroy() {
        if (this !== buffer) throw new Error('GPU test destroy receiver');
        if (record.destroyed) return;
        record.destroyed = true; liveBytes -= descriptor.size; records.delete(buffer);
      } };
      records.set(buffer, record); all.push(record); liveBytes += descriptor.size;
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, source, dataOffset = 0, size) {
        if (this !== device.queue || !records.has(buffer)) throw new Error('GPU test write ownership');
        if (nextWriteFailure) { const error = nextWriteFailure; nextWriteFailure = null; throw error; }
        const isView = ArrayBuffer.isView(source), unit = isView ? source.BYTES_PER_ELEMENT ?? 1 : 1;
        if (!isView && !(source instanceof ArrayBuffer)) throw new TypeError('GPU test source type');
        const available = source.byteLength;
        const start = dataOffset * unit, length = size === undefined ? available - start : size * unit;
        if (![offset, start, length].every(Number.isSafeInteger) || offset < 0 || start < 0 || length < 0
          || offset % 4 || length % 4 || start + length > available || offset + length > buffer.size) {
          throw new RangeError('GPU test write bounds');
        }
        const bytes = new Uint8Array(isView ? source.buffer : source, (isView ? source.byteOffset : 0) + start, length);
        records.get(buffer).bytes.set(bytes, offset); writes.push({ buffer, offset, length });
      },
    },
  };
  return { device, all, writes, bytes(buffer) { const record = records.get(buffer);
    if (!record) throw new Error('GPU test buffer absent/destroyed'); return record.bytes; },
  failNextWrite(error) { nextWriteFailure = error; }, get liveCount() { return records.size; },
  get liveBytes() { return liveBytes; } };
}

export const GPU_USAGE = Object.freeze({ MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
  INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });

// Filled from the unchanged committed Rust-produced conformance artifacts.
// No golden is regenerated, repaired into a triangle, or used as a success
// claim for strict triangle identity: each template has FOUR indices.
export const RUST_GOLDEN_HEX = Object.freeze({
  v1: '534e464901000000020000000300000018000000180000000800000000000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f00000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803f01000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f0000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000',
  v2: '534e46490200000002000000030000001800000018000000080000005c000000000000000c000000000000000c00000000000000040000000000000000000000000000000000000000000000000000000c0000000c0000000c0000000c000000040000000400000000000000000000000000000000000000000000000000000000000000e803000000000000cdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803ff401000000000000e9030000cdcccc3dcdcc4c3e9a99993e0000803f0000803f0000000000000000000080bf000000000000803f000000000000004000000000000000000000803f000000000000000000000000000000000000803ff501000001000000ea030000cdcc4c3ecdcc4c3e9a99993e0000803f0000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803f000000000000000000000000000000000000803ff60100000000803f00000000000000000000004000000000000000000000803f0000803f000000000000803f000000000000803f0000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000a0400000a0400000a0400000c0400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000020000000300000000000000010000000200000003000000',
});
