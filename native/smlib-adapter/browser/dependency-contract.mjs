// SPDX-License-Identifier: MPL-2.0
// #7955: analytic witnesses for one actual SDK incarnation, before dependency use.
// This does not qualify IFC traversal, styling or final product publication.
import { assert, request, response, u32, f64 } from './contract.mjs';

export async function runDependencyContract(transport, incarnation) {
  const call = async (opcode, ...fields) => {
    assert(transport.incarnation === incarnation, 'dependency witness owner is live');
    const frames = await transport.batch([request(opcode, ...fields)], incarnation);
    assert(transport.incarnation === incarnation, 'dependency witness owner survived dispatch');
    return response(frames[0]);
  };
  const session = await call(1);
  let failed = true;
  try {
    const box = await call(3, session, ...[0, 0, 0, 2, 3, 4].map(f64));
    const affine = [2, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 7, -4, 2, 1];
    const copyReply = await call(18, session, box, ...affine.map(f64));
    assert(copyReply.byteLength === 72, 'affine handle and certificate size');
    const certificate = new DataView(copyReply.buffer, copyReply.byteOffset + 16, 56);
    assert(certificate.getUint32(0, true) === 1 && certificate.getUint32(4, true) === 1,
      'affine version and rational representation');
    const copy = copyReply.slice(0, 16);
    const volume = async solid => {
      const bytes = await call(6, session, solid, f64(1e-8));
      assert(bytes.byteLength === 8, 'volume reply size');
      return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
    };
    const copiedVolume = await volume(copy);
    assert(Math.abs(copiedVolume - 48) < 1e-6, 'determinant-two affine preserves analytic volume');
    await call(8, session, copy);
    assert(Math.abs(await volume(box) - 24) < 1e-6, 'affine copy leaves its input unchanged');

    const rigid = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1];
    const moved = await call(17, session, box, ...rigid.map(f64));
    const difference = await call(5, session, box, moved, u32(3));
    await call(8, session, moved);
    const differenceVolume = await volume(difference);
    assert(Math.abs(differenceVolume - 12) < 1e-6, 'ordered placed Boolean analytic volume');
    const empty = await call(5, session, box, box, u32(3));
    const classification = await call(19, session, empty);
    assert(classification.byteLength === 4 && new DataView(classification.buffer).getUint32(0, true) === 1,
      'self difference has semantic empty certificate');
    const recovered = await call(5, session, empty, box, u32(1));
    assert(Math.abs(await volume(recovered) - 24) < 1e-6, 'certified empty remains a valid union operand');
    for (const solid of [recovered, empty, difference, box]) await call(8, session, solid);
    failed = false;
    return { affineVolume: copiedVolume, placedDifferenceVolume: differenceVolume, emptyUnionVolume: 24 };
  } finally {
    try { await call(2, session); }
    catch (error) { if (!failed) throw error; }
  }
}
