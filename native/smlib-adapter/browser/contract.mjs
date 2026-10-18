// SPDX-License-Identifier: MPL-2.0
// Shared real-kernel contract exercised through Node and browser Workers.
export function assert(condition, message) { if (!condition) throw new Error(message); }
export const u32 = (value) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, value, true); return a; };
export const u64 = (value) => { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, value, true); return a; };
export const f64 = (value) => { const a = new Uint8Array(8); new DataView(a.buffer).setFloat64(0, value, true); return a; };
export function request(opcode, ...fields) {
  const all = [u32(1), u32(73), u32(opcode), ...fields];
  const frame = new Uint8Array(all.reduce((size, item) => size + item.length, 0));
  let cursor = 0;
  for (const item of all) { frame.set(item, cursor); cursor += item.length; }
  return frame.buffer;
}
export function response(frame, expectedStatus = 0) {
  const view = new DataView(frame);
  assert(view.getUint32(0, true) === 1 && view.getUint32(4, true) === 73, 'response envelope');
  assert(view.getInt32(8, true) === expectedStatus, `response status: ${view.getInt32(8, true)} ${new TextDecoder().decode(frame.slice(12))}`);
  return new Uint8Array(frame.slice(12));
}
export async function runContract(batch) {
  const call = async (op, ...fields) => response((await batch([request(op, ...fields)]))[0]);
  assert(new DataView(u64(0xfedcba9876543210n).buffer).getBigUint64(0, true) === 0xfedcba9876543210n, 'u64 precision');
  const session = await call(1);
  assert(new DataView(session.buffer).getBigUint64(0, true) > 0n, 'session identifier');
  const box = await call(3, session, ...[0, 0, 0, 2, 3, 4].map(f64));
  const other = await call(3, session, ...[1, 0, 0, 2, 3, 4].map(f64));
  const solid = await call(5, session, box, other, u32(3));
  const volume = new DataView((await call(6, session, solid, f64(1e-8))).buffer).getFloat64(0, true);
  assert(Math.abs(volume - 12) < 1e-6, 'boolean analytic volume');
  const manifold = await call(7, session, solid);
  assert(new DataView(manifold.buffer).getUint32(0, true) === 1, 'BRep manifold');
  const mesh = await call(9, session, solid, f64(0.001), f64(5));
  // A mesh owns its buffers independently of the source BRep.
  await call(8, session, solid);
  const info = new DataView((await call(10, session, mesh)).buffer);
  const vertices = info.getUint32(0, true), triangles = info.getUint32(4, true);
  assert(vertices > 0 && triangles > 0 && info.getUint32(12, true) === 0 &&
    info.getUint32(16, true) === 0 && info.getUint32(20, true) === 0, 'strict mesh topology');
  async function read(stream, count, scalarSize) {
    const frames = [];
    for (let offset = 0; offset < count; offset += 480) {
      frames.push(request(11, session, mesh, u32(stream), u32(offset), u32(Math.min(480, count - offset))));
    }
    const bytes = new Uint8Array(count * scalarSize);
    let offset = 0;
    for (const frame of await batch(frames)) {
      const part = response(frame); bytes.set(part, offset); offset += part.length;
    }
    assert(offset === bytes.length, 'complete mesh byte transfer');
    return new DataView(bytes.buffer);
  }
  const positions = await read(1, vertices * 3, 8);
  const indices = await read(2, triangles * 3, 4);
  const faces = await read(3, triangles, 4);
  const normals = await read(4, triangles * 9, 8);
  let signedVolume = 0;
  for (let t = 0; t < triangles; t++) {
    const p = [];
    for (let corner = 0; corner < 3; corner++) {
      const index = indices.getUint32((t * 3 + corner) * 4, true);
      assert(index < vertices, 'index bound');
      p.push([0, 1, 2].map((axis) => positions.getFloat64((index * 3 + axis) * 8, true)));
      const n = [0, 1, 2].map((axis) => normals.getFloat64((t * 9 + corner * 3 + axis) * 8, true));
      assert(Math.abs(Math.hypot(...n) - 1) < 1e-9, 'unit normal');
    }
    assert(faces.getUint32(t * 4, true) < info.getUint32(8, true), 'face bound');
    const [a, b, c] = p;
    signedVolume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
  }
  assert(Math.abs(Math.abs(signedVolume) - 12) < 1e-6, 'independent triangle volume');
  const stale = await batch([request(8, session, solid)]);
  response(stale[0], 3);
  // Command failures preserve the stream and original operands.
  const original = new DataView((await call(6, session, box, f64(1e-8))).buffer).getFloat64(0, true);
  assert(Math.abs(original - 24) < 1e-6, 'immutable source operand');
  await call(8, session, mesh);
  await call(8, session, box);
  await call(8, session, other);
  await call(2, session);
  return { volume, triangleVolume: Math.abs(signedVolume), vertices, triangles, session: new DataView(session.buffer).getBigUint64(0, true).toString() };
}
