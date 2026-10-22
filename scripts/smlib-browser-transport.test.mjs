// SPDX-License-Identifier: MPL-2.0
// Browser module-Worker transport for the SMLib adapter: owned dispatch,
// client incarnations and the staged sweep upload. Protocol peers and fixture
// Workers only; nothing here is SDK geometry evidence (that is the CTest
// `smlib_browser_protocol` lane and the actual-Worker browser runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOwned } from '../native/smlib-adapter/browser/module.mjs';
import { SmlibWorkerTransport } from '../native/smlib-adapter/browser/client.mjs';
import { uploadSweep } from '../native/smlib-adapter/browser/sweep.mjs';
import { regionRecipe, rectangleRecipe, diskRecipe } from '../native/smlib-adapter/browser/sweep-contract.mjs';

function frame(opcode, size = 12) {
  const bytes = new ArrayBuffer(size), view = new DataView(bytes);
  view.setUint32(0, 1, true); view.setUint32(4, 7, true); view.setUint32(8, opcode, true);
  return bytes;
}
/** Emscripten-shaped module whose dispatch returns one `size`-byte response. */
function allocation(size, status = 0) {
  const HEAPU8 = new Uint8Array(65536), view = new DataView(HEAPU8.buffer), freed = [];
  let next = 64;
  return { HEAPU8, freed, _malloc(n) { const p = next; next += n; return p; }, _free(p) { freed.push(p); },
    _ifclite_smlib_dispatch_owned(_request, _length, out, length) {
      view.setUint32(out, 8192, true); view.setUint32(length, size, true);
      view.setUint32(8192, 1, true); view.setUint32(8196, 7, true); view.setInt32(8200, status, true);
      return 0;
    } };
}
class FixtureWorker {
  static instances = [];
  constructor(url, options) { this.url = url; this.options = options; FixtureWorker.instances.push(this); }
  terminate() { this.terminated = true; }
  postMessage(message, transfers) { this.message = structuredClone(message, { transfer: transfers }); }
  reply(sizes = [12], status = 0) {
    this.onmessage({ data: { id: this.message.id, frames: sizes.map((size) => {
      const bytes = new ArrayBuffer(size);
      if (size >= 12) { const view = new DataView(bytes); view.setUint32(0, 1, true); view.setInt32(8, status, true); }
      return bytes;
    }) } });
  }
}
function withWorker(run) {
  return async () => {
    const previous = globalThis.Worker;
    globalThis.Worker = FixtureWorker;
    try { await run(); } finally { globalThis.Worker = previous; }
  };
}

test('owned dispatch frees every allocation and refuses responses above one frame', () => {
  for (const [size, accepted] of [[4096, true], [12, true], [4097, false], [11, false]]) {
    const module = allocation(size);
    if (accepted) assert.equal(dispatchOwned(module, frame(9)).byteLength, size);
    else assert.throws(() => dispatchOwned(module, frame(9)), /response allocation/);
    assert.equal(module.freed.length, 3);
  }
  const module = allocation(12);
  assert.throws(() => dispatchOwned(module, frame(9, 4097)), /request frame/);
  assert.deepEqual(module.freed, []);
});

test('client starts one module Worker and transfers frames on submission', withWorker(async () => {
  const transport = new SmlibWorkerTransport({ workerUrl: '/smlib/worker.mjs' });
  try {
    const worker = FixtureWorker.instances.at(-1);
    assert.deepEqual([worker.url, worker.options], ['/smlib/worker.mjs', { type: 'module' }]);
    const frames = [frame(0), frame(12)];
    const pending = transport.batch(frames, transport.incarnation);
    assert.ok(frames.every((f) => f.byteLength === 0), 'ownership moved to the Worker');
    worker.reply([16, 20]);
    assert.deepEqual((await pending).map((f) => f.byteLength), [16, 20]);
  } finally { transport.dispose(); }
}));

test('invalid responses poison the captured incarnation; oversize requests stay unsent', withWorker(async () => {
  for (const [sizes, status] of [[[4097], 0], [[12, 12], 0], [[11], 0]]) {
    const transport = new SmlibWorkerTransport(), incarnation = transport.incarnation;
    const pending = transport.batch([frame(9)], incarnation);
    FixtureWorker.instances.at(-1).reply(sizes, status);
    await assert.rejects(pending, /invalid worker response/);
    assert.equal(transport.incarnation, undefined);
    assert.ok(FixtureWorker.instances.at(-1).terminated);
    transport.dispose();
  }
  const transport = new SmlibWorkerTransport(), oversize = frame(9, 4097);
  await assert.rejects(transport.batch([oversize], transport.incarnation), /invalid frame batch/);
  assert.equal(oversize.byteLength, 4097);
  transport.dispose();
}));

test('fatal Worker fault invalidates the token; stale retire cannot kill a restart', withWorker(async () => {
  const transport = new SmlibWorkerTransport();
  try {
    const old = transport.incarnation;
    const pending = transport.batch([frame(0)], old);
    FixtureWorker.instances.at(-1).onmessage({ data: { fatal: 'fault fixture' } });
    await assert.rejects(pending, /fault fixture/);
    assert.equal(transport.incarnation, undefined);
    await assert.rejects(transport.batch([frame(0)], old), /unavailable/);
    const fresh = transport.restart();
    assert.notEqual(fresh, old);
    transport.retire(old);
    assert.equal(transport.incarnation, fresh);
    await assert.rejects(transport.batch([frame(0)], old), /stale worker incarnation/);
    const healthy = transport.batch([frame(0)], fresh);
    FixtureWorker.instances.at(-1).reply();
    await healthy;
    transport.retire(fresh);
    assert.equal(transport.incarnation, undefined);
  } finally { transport.dispose(); }
}));

test('restart rejects in-flight work and replaces the actual Worker object', withWorker(async () => {
  const transport = new SmlibWorkerTransport();
  try {
    const first = FixtureWorker.instances.at(-1);
    const pending = transport.batch([frame(14)], transport.incarnation);
    transport.restart();
    await assert.rejects(pending, /restarted/);
    assert.ok(first.terminated);
    assert.notEqual(FixtureWorker.instances.at(-1), first);
    first.onmessage({ data: { id: 1, frames: [new ArrayBuffer(12)] } }); // late reply is ignored
    assert.notEqual(transport.incarnation, undefined);
  } finally { transport.dispose(); }
}));

test('pending admission refuses an unsent commit without detaching it', withWorker(async () => {
  const transport = new SmlibWorkerTransport({ maxPending: 1 });
  try {
    const token = transport.incarnation;
    const pending = transport.batch([frame(0)], token);
    const commit = frame(15);
    await assert.rejects(transport.batch([commit], token), (error) => error.submitted === false);
    assert.equal(commit.byteLength, 12);
    FixtureWorker.instances.at(-1).reply();
    await pending;
  } finally { transport.dispose(); }
}));

test('deadline terminates an unresponsive Worker', withWorker(async () => {
  const transport = new SmlibWorkerTransport({ timeout: 5 });
  try {
    await assert.rejects(transport.batch([frame(0)], transport.incarnation), /deadline/);
    assert.ok(FixtureWorker.instances.at(-1).terminated);
    assert.equal(transport.incarnation, undefined);
  } finally { transport.dispose(); }
}));

// A 2 x 4 rectangle split into 128 line segments: four frames of upload.
const STRIP = (() => {
  const corners = [[0, 0], [2, 0], [2, 4], [0, 4]], points = [];
  for (let edge = 0; edge < 4; edge++) for (let part = 0; part < 32; part++) {
    const [a, b] = [corners[edge], corners[(edge + 1) % 4]];
    points.push([a[0] + (b[0] - a[0]) * part / 32, a[1] + (b[1] - a[1]) * part / 32]);
  }
  const values = (a, b) => [a[0], a[1], 0, b[0], b[1], 0, 0, 0, 0, 0, 0, 0];
  return [points.map((point, i) => ({ kind: 1, values: values(point, points[(i + 1) % points.length]) }))];
})();

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
test('sweep upload: owns recipe across awaits and chunks input larger than v1 frames', async () => {
  const transport = peer(), recipe = regionRecipe(STRIP).bytes, expected = new Uint8Array(recipe);
  const pending = uploadSweep(transport, 1n, recipe, { loops: 1, segments: 128 }, transport.incarnation);
  recipe.fill(99);
  await pending;
  assert.deepEqual(transport.calls, [12, 13, 14, 14, 14, 14, 15]);
  assert.deepEqual(Uint8Array.from(transport.chunks.flatMap((chunk) => [...chunk])), expected);
  assert(transport.chunks.every((chunk) => chunk.length <= 3840));
});
test('sweep upload: chunk error aborts and never commits', async () => {
  const transport = peer({ failChunk: true });
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments: 4 }, transport.incarnation), /status 1/);
  assert.deepEqual(transport.calls, [12, 13, 14, 16]);
});
test('sweep upload: invalid counts refuse before transport', async () => {
  const transport = peer();
  for (const segments of [0, 8193, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments }, transport.incarnation));
  }
  assert.deepEqual(transport.calls, []);
});
test('sweep upload: uncertain begin token retires transport without resubmission', async () => {
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    const result = await original.call(this, frames, incarnation);
    if (new DataView(frames[0]).getUint32(8, true) === 13) return [result[0].slice(0, 16)];
    return result;
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments: 4 }, transport.incarnation), /token/);
  assert.equal(transport.disposed, true);
  assert.deepEqual(transport.calls, [12, 13]);
});
test('sweep upload: foreign successful handle retires incarnation before publication', async () => {
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    const result = await original.call(this, frames, incarnation);
    if (new DataView(frames[0]).getUint32(8, true) === 15) new DataView(result[0]).setBigUint64(12, 2n, true);
    return result;
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments: 4 }, transport.incarnation), /foreign/);
  assert.equal(transport.disposed, true);
  assert.deepEqual(transport.calls, [12, 13, 14, 15]);
});

test('sweep upload: pre-dispatch commit rejection aborts live upload', async () => {
  const transport = peer(), original = transport.batch;
  let active = false;
  transport.batch = async function (frames, incarnation) {
    const op = new DataView(frames[0]).getUint32(8, true);
    if (op === 15) throw Object.assign(new Error('capacity'), { submitted: false });
    if (op === 13) { assert.equal(active, false); active = true; }
    if (op === 16) active = false;
    return original.call(this, frames, incarnation);
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments: 4 }, transport.incarnation), /capacity/);
  assert.equal(active, false);
  assert.equal(transport.disposed, false);
  assert.equal(transport.calls.at(-1), 16);
});
test('sweep upload: uncertain commit retires owner without retry', async () => {
  const transport = peer(), original = transport.batch;
  transport.batch = async function (frames, incarnation) {
    if (new DataView(frames[0]).getUint32(8, true) === 15) throw new Error('lost response');
    return original.call(this, frames, incarnation);
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments: 4 }, transport.incarnation), /lost response/);
  assert.equal(transport.disposed, true);
  assert(!transport.calls.includes(16));
});
test('sweep upload: old upload rejection preserves replacement incarnation', async () => {
  const transport = peer(), original = transport.batch;
  const old = transport.incarnation;
  transport.batch = async function (frames, incarnation) {
    if (new DataView(frames[0]).getUint32(8, true) === 14) {
      this.incarnation = {};
      throw new Error('worker restarted');
    }
    return original.call(this, frames, incarnation);
  };
  await assert.rejects(uploadSweep(transport, 1n, rectangleRecipe().bytes, { loops: 1, segments: 4 }, old), /restarted/);
  assert.equal(transport.disposed, false);
  assert.notEqual(transport.incarnation, old);
});

test('sweep upload: format2 capability is required before declaring exact rational coefficients', async () => {
  const unavailable = peer();
  await assert.rejects(uploadSweep(unavailable, 1n, diskRecipe(false).bytes,
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
  const recipe = diskRecipe(false).bytes;
  await uploadSweep(transport, 1n, recipe, { loops: 1, segments: 1, format: 2 }, transport.incarnation);
  assert.deepEqual(Uint8Array.from(transport.chunks.flatMap(chunk => [...chunk])), recipe);
});
