// SPDX-License-Identifier: MPL-2.0
// Protocol fault injection only. This peer supplies NO geometry evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadSweep } from './sweep.mjs';
import { rectangleRecipe, diskRecipe } from './sweep-contract.mjs';
function peer({ failChunk = false } = {}) {
  const calls = [], chunks = [];
  return { calls, chunks, incarnation: {}, disposed: false,
    dispose() { this.disposed = true; },
    async batch([frame], incarnation) {
      assert.equal(incarnation, this.incarnation);
      const view = new DataView(frame), op = view.getUint32(8, true);
      calls.push(op);
      let body = new Uint8Array(), status = 0;
      if (op === 12) { body = new Uint8Array(8); new DataView(body.buffer).setUint32(0, 1, true); body[4] = 1; }
      if (op === 13) { body = new Uint8Array(8); body[0] = 123; }
      if (op === 14) {
        assert.equal(view.getUint32(28, true), chunks.reduce((n, c) => n + c.length, 0));
        chunks.push(new Uint8Array(frame.slice(36)));
        if (failChunk) status = 1;
      }
      if (op === 15) { body = new Uint8Array(16); body[0] = 1; body[12] = 1; }
      const result = new ArrayBuffer(12 + body.length), response = new DataView(result);
      response.setUint32(0, 1, true); response.setUint32(4, view.getUint32(4, true), true);
      response.setInt32(8, status, true); new Uint8Array(result, 12).set(body);
      return [result];
    } };
}
test('round1 owns recipe across awaits and chunks input larger than v1 frames', async () => {
  const transport = peer(), recipe = rectangleRecipe(32), expected = new Uint8Array(recipe);
  const pending = uploadSweep(transport, 1n, recipe, { loops: 1, segments: 128 }, transport.incarnation);
  recipe.fill(99);
  await pending;
  assert.deepEqual(transport.calls, [12, 13, 14, 14, 14, 14, 15]);
  assert.deepEqual(Uint8Array.from(transport.chunks.flatMap((chunk) => [...chunk])), expected);
  assert(transport.chunks.every((chunk) => chunk.length <= 3840));
});
test('round1 chunk error aborts and never commits', async () => {
  const transport = peer({ failChunk: true });
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments: 4 }, transport.incarnation), /status 1/);
  assert.deepEqual(transport.calls, [12, 13, 14, 16]);
});
test('round1 invalid counts refuse before transport', async () => {
  const transport = peer();
  for (const segments of [0, 8193, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments }, transport.incarnation));
  }
  assert.deepEqual(transport.calls, []);
});
test('round1 uncertain begin token retires transport without resubmission', async () => {
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    const result = await original.call(this, frames, incarnation);
    if (new DataView(frames[0]).getUint32(8, true) === 13) return [result[0].slice(0, 16)];
    return result;
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments: 4 }, transport.incarnation), /token/);
  assert.equal(transport.disposed, true);
  assert.deepEqual(transport.calls, [12, 13]);
});
test('round1 foreign successful handle retires incarnation before publication', async () => {
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    const result = await original.call(this, frames, incarnation);
    if (new DataView(frames[0]).getUint32(8, true) === 15) new DataView(result[0]).setBigUint64(12, 2n, true);
    return result;
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments: 4 }, transport.incarnation), /foreign/);
  assert.equal(transport.disposed, true);
  assert.deepEqual(transport.calls, [12, 13, 14, 15]);
});

test('browser review: pre-dispatch commit rejection aborts live upload', async () => {
  const transport = peer(), original = transport.batch;
  let active = false;
  transport.batch = async function (frames, incarnation) {
    const op = new DataView(frames[0]).getUint32(8, true);
    if (op === 15) throw Object.assign(new Error('capacity'), { submitted: false });
    if (op === 13) { assert.equal(active, false); active = true; }
    if (op === 16) active = false;
    return original.call(this, frames, incarnation);
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments: 4 }, transport.incarnation), /capacity/);
  assert.equal(active, false);
  assert.equal(transport.disposed, false);
  assert.equal(transport.calls.at(-1), 16);
});
test('browser review: uncertain commit retires owner without retry', async () => {
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    if (new DataView(frames[0]).getUint32(8, true) === 15) throw new Error('lost response');
    return original.call(this, frames, incarnation);
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments: 4 }, transport.incarnation), /lost response/);
  assert.equal(transport.disposed, true);
  assert(!transport.calls.includes(16));
});
test('browser review: old upload rejection preserves replacement incarnation', async () => {
  const transport = peer(), original = transport.batch;
  const old = transport.incarnation;
  transport.batch = async function (frames, incarnation) {
    if (new DataView(frames[0]).getUint32(8, true) === 14) {
      this.incarnation = {};
      throw new Error('worker restarted');
    }
    return original.call(this, frames, incarnation);
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe(), { loops: 1, segments: 4 }, old), /restarted/);
  assert.equal(transport.disposed, false);
  assert.notEqual(transport.incarnation, old);
});

test('round3 format2 capability is required before declaring exact rational coefficients', async () => {
  const unavailable = peer();
  await assert.rejects(uploadSweep(unavailable, 1n, diskRecipe(),
    { loops: 1, segments: 1, format: 2 }, unavailable.incarnation), /unavailable/);
  assert.deepEqual(unavailable.calls, [12]);
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    const op = new DataView(frames[0]).getUint32(8, true);
    if (op === 13) assert.equal(new DataView(frames[0]).getUint32(20, true), 2);
    const result = await original.call(this, frames, incarnation);
    if (op === 12) new DataView(result[0]).setUint32(16, 3, true);
    return result;
  };
  const recipe = diskRecipe();
  await uploadSweep(transport, 1n, recipe, { loops: 1, segments: 1, format: 2 }, transport.incarnation);
  assert.deepEqual(Uint8Array.from(transport.chunks.flatMap(chunk => [...chunk])), recipe);
});
