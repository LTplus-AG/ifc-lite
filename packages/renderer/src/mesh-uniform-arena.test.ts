/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MeshUniformArena, readMeshUniforms, stageMeshUniforms } from './mesh-uniform-arena.js';
import { MESH_UNIFORM_BYTES, MESH_UNIFORM_FLOATS } from './mesh-rte-uniforms.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

interface FakeBuffer { size: number; bytes: Uint8Array; destroyed: boolean; destroy(): void }

/** A device whose buffers keep real bytes, so a test reads what the GPU would. */
function fakeDevice() {
  const buffers: FakeBuffer[] = [];
  const writes: { buffer: FakeBuffer; offset: number; bytes: number }[] = [];
  const device = {
    createBuffer({ size }: { size: number }) {
      const buffer: FakeBuffer = { size, bytes: new Uint8Array(size), destroyed: false, destroy() { this.destroyed = true; } };
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferView) {
        assert.equal(buffer.destroyed, false, 'write into a destroyed page');
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
        writes.push({ buffer, offset, bytes: data.byteLength });
      },
    },
  };
  return { device: device as unknown as GPUDevice, buffers, writes };
}

function block(seed: number): Float32Array {
  const data = new Float32Array(MESH_UNIFORM_FLOATS);
  for (let i = 0; i < data.length; i++) data[i] = seed * 1000 + i;
  return data;
}

function gpuBytes(slot: { buffer: GPUBuffer; offset: number; size: number }): Float32Array {
  const bytes = (slot.buffer as unknown as FakeBuffer).bytes;
  return new Float32Array(bytes.slice(slot.offset, slot.offset + slot.size).buffer);
}

describe('MeshUniformArena', () => {
  it('uploads every staged draw of a page in ONE write, at each slot\'s own aligned offset', () => {
    const { device, writes } = fakeDevice();
    const arena = new MeshUniformArena(device, MESH_UNIFORM_BYTES, 64);
    const slots = Array.from({ length: 40 }, () => arena.allocate());
    slots.forEach((slot, i) => {
      assert.equal(slot.offset % 256, 0, 'bind-group offsets must honour minUniformBufferOffsetAlignment');
      assert.equal(slot.size, MESH_UNIFORM_BYTES);
      stageMeshUniforms(slot, block(i + 1));
    });
    assert.equal(arena.flush(device.queue), 1);
    assert.equal(writes.length, 1, 'one queue operation for 40 draws (#6393 lesson: count queue ops)');
    slots.forEach((slot, i) => assert.deepEqual(gpuBytes(slot), block(i + 1)));
  });

  it('writes nothing when a still camera re-stages identical bytes', () => {
    const { device, writes } = fakeDevice();
    const arena = new MeshUniformArena(device, MESH_UNIFORM_BYTES, 8);
    const slot = arena.allocate();
    const data = block(3);
    // 0xFFFFFFFF is a NaN bit pattern as f32 (the "no anchor" override lane):
    // compared as floats it would look changed on every frame.
    new Uint32Array(data.buffer)[92] = 0xFFFFFFFF;
    arena.stage(slot, data);
    arena.flush(device.queue);
    arena.stage(slot, data);
    assert.equal(arena.flush(device.queue), 0);
    assert.equal(writes.length, 1);
    data[0] = 42;
    arena.stage(slot, data);
    assert.equal(arena.flush(device.queue), 1);
    assert.equal(readMeshUniforms(slot)[0], 42);
  });

  it('a stale handle to a recycled block cannot free its new owner', () => {
    const { device } = fakeDevice();
    const arena = new MeshUniformArena(device, MESH_UNIFORM_BYTES, 4);
    const evicted = arena.allocate();
    evicted.release();
    arena.flush(device.queue); // recycles the block
    const owner = arena.allocate();
    assert.equal(owner.offset, evicted.offset);
    const others = Array.from({ length: 3 }, () => arena.allocate());
    evicted.release(); // a second destroy of the evicted batch
    arena.flush(device.queue);
    const next = arena.allocate();
    assert.ok(![owner, ...others].some((s) => s.offset === next.offset && s.buffer === next.buffer));
  });

  it('spans one write per page that changed, covering only the dirty slot range', () => {
    const { device, writes } = fakeDevice();
    const arena = new MeshUniformArena(device, MESH_UNIFORM_BYTES, 4);
    const slots = Array.from({ length: 9 }, () => arena.allocate());
    assert.equal(arena.pageCount, 3);
    slots.forEach((slot, i) => arena.stage(slot, block(i)));
    assert.equal(arena.flush(device.queue), 3);
    writes.length = 0;
    arena.stage(slots[5]!, block(50));
    arena.stage(slots[6]!, block(60));
    assert.equal(arena.flush(device.queue), 1);
    assert.deepEqual(writes.map((w) => [w.offset, w.bytes]), [[512, 512 + MESH_UNIFORM_BYTES]]);
  });

  it('does not hand a released slot to a new owner before the frame flush', () => {
    // A batch drawn earlier in a frame and released later in the SAME frame
    // must still read its own bytes when the frame executes.
    const { device } = fakeDevice();
    const arena = new MeshUniformArena(device, MESH_UNIFORM_BYTES, 2);
    const a = arena.allocate();
    arena.stage(a, block(1));
    a.release();
    a.release(); // idempotent
    const b = arena.allocate();
    assert.ok(!(b.offset === a.offset && b.buffer === a.buffer), 'released slot reused within the frame');
    arena.flush(device.queue);
    assert.deepEqual(gpuBytes(a), block(1));
    assert.throws(() => arena.stage(a, block(2)), /released/);
    const reused = [arena.allocate(), arena.allocate()];
    assert.ok(reused.some((s) => s.buffer === a.buffer && s.offset === a.offset), 'recycled after the flush');
  });

  it('returns wholly released pages to the driver but keeps one warm', () => {
    const { device, buffers } = fakeDevice();
    const arena = new MeshUniformArena(device, MESH_UNIFORM_BYTES, 2);
    const slots = Array.from({ length: 6 }, () => arena.allocate());
    assert.equal(arena.pageCount, 3);
    for (const slot of slots) slot.release();
    arena.flush(device.queue);
    assert.equal(arena.pageCount, 1);
    assert.equal(buffers.filter((b) => b.destroyed).length, 2);
    // The survivor still serves allocations; new pages appear on demand.
    const again = Array.from({ length: 3 }, () => arena.allocate());
    assert.equal(arena.pageCount, 2);
    for (const slot of again) assert.equal((slot.buffer as unknown as FakeBuffer).destroyed, false);
  });
});
