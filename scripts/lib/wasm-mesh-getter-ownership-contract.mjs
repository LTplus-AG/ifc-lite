// Real WASM ownership invariant for redundant worker getter copies (#3989).
import assert from 'node:assert/strict';
const bytesOf = array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
function collection(api, source) {
  const pre = api.buildPrePassOnce(source);
  assert.ok(pre.totalJobs > 0, 'Ownership fixture needs real geometry jobs');
  return api.processGeometryBatch(source, pre.jobs, pre.unitScale,
    ...pre.rtcOffset, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
}
export function checkMeshGetterOwnershipContract(IfcAPI, memory, source, kind = 'geometry') {
  const api = new IfcAPI();
  const retained = {}, snapshots = {};
  try {
    const meshes = collection(api, source);
    let found = false;
    try {
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes.takeMesh(i);
        if (!mesh) continue;
        try {
          const eligible = kind === 'embedded' ? mesh.hasTexture : kind === 'external' ? !!mesh.textureUrl : mesh.vertexCount > 0;
          if (!eligible) continue;
          const fields = ['positions', 'normals', 'indices', ...(kind !== 'geometry' ? ['uvs'] : []), ...(kind === 'embedded' ? ['textureRgba'] : [])];
          for (const field of fields) {
            const first = mesh[field], second = mesh[field];
            assert.ok(ArrayBuffer.isView(first), `${field} must be a typed-array getter`);
            assert.ok(first.length > 0, `${kind} fixture needs nonempty ${field}`);
            assert.notEqual(first.buffer, memory.buffer, `${field} must not alias the WASM heap`);
            assert.notEqual(first.buffer, second.buffer, `${field} calls must own independent backing`);
            const expected = bytesOf(second).slice();
            assert.deepEqual(bytesOf(first), expected);
            const owned = bytesOf(first); owned[0] ^= 0x80;
            assert.deepEqual(bytesOf(second), expected, `${field} getter copies alias each other`);
            assert.deepEqual(bytesOf(mesh[field]), expected, `${field} JS mutation reached Rust mesh`);
            owned[0] ^= 0x80;
            retained[field] = first; snapshots[field] = expected;
          }
          found = true;
        } finally { mesh.free(); }
        if (found) break;
      }
      assert.ok(found, `Missing actual ${kind} ownership witness`);
    } finally { meshes.free(); api.clearPrePassCache(); }
    // Real subsequent processing reuses freed Rust allocations.
    const next = collection(api, source);
    try { assert.ok(next.totalVertices > 0, 'Next allocation must produce geometry'); }
    finally { next.free(); api.clearPrePassCache(); }
    const priorWasmBytes = memory.buffer.byteLength;
    memory.grow(1);
    assert.equal(memory.buffer.byteLength, priorWasmBytes + 65536, 'Exercise actual WASM memory growth');
    for (const [field, value] of Object.entries(retained)) {
      assert.deepEqual(bytesOf(value), snapshots[field], `${field} changed after free/reallocation/growth`);
    }
    // Mirrors existing worker transfers, without wrapping getter arrays.
    const buffers = Object.values(retained).map(value => value.buffer);
    assert.equal(new Set(buffers).size, buffers.length, 'Different getters need separately transferable backing');
    const received = structuredClone(retained, { transfer: buffers });
    for (const [field, value] of Object.entries(retained)) {
      assert.equal(value.byteLength, 0, `${field} worker ownership was not transferred`);
      assert.deepEqual(bytesOf(received[field]), snapshots[field], `${field} receiver data changed`);
    }
  } finally { api.clearPrePassCache(); api.free(); }
}
