// SPDX-License-Identifier: MPL-2.0
// ifc-lite-wasm's private retained browser driver (js/retained-driver.mjs)
// against a protocol peer standing in for /smlib/. Lifetime and ordering only:
// this never qualifies geometry (the actual-Worker runs in
// rust/wasm-bindings/src/retained_browser/bridge_tests.rs do that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const fixtures = new URL('./lib/__fixtures__/retained-driver/', import.meta.url);
register(new URL('hooks.mjs', fixtures), { data: {
  peer: new URL('peer.mjs', fixtures).href, client: new URL('client.mjs', fixtures).href,
} });
const { peers, imports, nextPeer, holdStartup } = await import(new URL('peer.mjs', fixtures));
const { RetainedDriver } = await import('../rust/wasm-bindings/js/retained-driver.mjs');

const flush = async () => { for (let i = 0; i < 50; i++) await new Promise((done) => setImmediate(done)); };
const evaluate = (driver, qualification = 0, maxBytes = 4096) =>
  driver.evaluate(new Uint8Array([7, 7]), 1, 1, 4, qualification, 0.001, 5, maxBytes);
const opcodes = (peer) => peer.commands.map(({ op }) => op);

test('importing the driver fetches no /smlib/ module; construction loads exactly the transport', async () => {
  assert.deepEqual(imports, []);
  const constructed = nextPeer();
  const driver = new RetainedDriver();
  await constructed;
  assert.deepEqual(imports, ['client']);
  assert.equal(peers.at(-1).options.workerUrl, '/smlib/worker.mjs');
  driver.retire();
});

test('retirement before startup never constructs the transport', async () => {
  const before = peers.length;
  const driver = new RetainedDriver();
  driver.retire();
  await flush();
  assert.equal(peers.length, before);
  await assert.rejects(evaluate(driver), /cancelled before startup|unavailable/);
});

test('evaluation owns its recipe, seals one lease and releases the temporary mesh', async () => {
  const driver = new RetainedDriver();
  const recipe = new Uint8Array([1, 2, 3]);
  const pending = driver.evaluate(recipe, 1, 1, 4, 0, 0.001, 5, 4096);
  recipe.fill(9);
  const { object, mesh } = await pending;
  const peer = peers.at(-1);
  assert.deepEqual(peer.uploads[0].bytes, [1, 2, 3]);
  assert.deepEqual(opcodes(peer), [1, 9, 10, 11, 11, 11, 11, 8]);
  assert.equal(peer.objects.size, 1, 'only the sealed solid remains');
  assert.equal(driver.objectLive(object), true);
  assert.deepEqual([mesh.positions.length, mesh.indices.length, mesh.source_face_count], [9, 3, 1]);
  driver.retire();
  assert.equal(driver.objectLive(object), false);
  assert.equal(peer.retired, true);
});

test('a dropped lease is invalid at once and released before the next result is accepted', async () => {
  const driver = new RetainedDriver();
  const first = await evaluate(driver), peer = peers.at(-1);
  const solid = peer.slot - 1; // the sealed solid precedes its released mesh
  const released = driver.nextDispatch(8);
  driver.releaseObject(first.object);
  assert.equal(driver.objectLive(first.object), false);
  assert.equal(await released, 8);
  const before = peer.commands.length;
  const second = await evaluate(driver);
  const releaseIndex = peer.commands.findIndex(({ op, slot }) => op === 8 && slot === solid);
  assert.ok(releaseIndex >= 0 && releaseIndex < before, 'release preceded the next construction');
  assert.ok(driver.objectLive(second.object));
  assert.equal(peer.objects.size, 1);
  driver.releaseObject(second.object);
  await flush();
  assert.equal(peer.objects.size, 0);
  assert.equal(driver.live(), true, 'healthy releases keep the Worker');
  driver.retire();
});

test('a replaced transport incarnation retires the driver and every lease', async () => {
  const driver = new RetainedDriver();
  const { object } = await evaluate(driver);
  const peer = peers.at(-1);
  peer.incarnation = Object.freeze({}); // the transport restarted under us
  assert.equal(driver.live(), false);
  assert.equal(driver.objectLive(object), false);
  await assert.rejects(evaluate(driver), /unavailable/);
});

test('#8048 response identity and release failures retire the captured Worker', async () => {
  for (const fault of ['wrongReply', 'release']) {
    const constructed = nextPeer();
    const driver = new RetainedDriver();
    const peer = await constructed;
    if (fault === 'release') {
      const { object } = await evaluate(driver);
      peer.objects.clear();
      driver.releaseObject(object);
      await flush();
      assert.equal(driver.live(), false, fault);
      assert.equal(peer.retired, true);
      continue;
    }
    if (fault === 'wrongReply') peer.wrongReply = true;
    await assert.rejects(evaluate(driver), /identity/);
    assert.equal(driver.live(), false, fault);
    assert.equal(peer.retired, true);
  }
});

test('curved families need this incarnation’s witnesses; refusal keeps Worker and leases', async () => {
  const driver = new RetainedDriver();
  const { object } = await evaluate(driver);
  const peer = peers.at(-1), count = peer.commands.length;
  await assert.rejects(evaluate(driver, 1), /UnqualifiedRegion/);
  await assert.rejects(evaluate(driver, 2), /UnqualifiedRegion/);
  assert.equal(peer.commands.length, count, 'nothing submitted');
  assert.equal(driver.objectLive(object), true);
  await assert.rejects(driver.evaluate(new Uint8Array(1), 1, 1, 4, 0, 0.001, 181, 4096), /limits/);
  await assert.rejects(driver.evaluate(new Uint8Array(1), 1, 1, 4, 3, 0.001, 5, 4096), /qualification/);
  assert.equal(driver.live(), true);
  await driver.qualify();
  await evaluate(driver, 1);
  await evaluate(driver, 2);
  const constructed = nextPeer();
  const failing = new RetainedDriver();
  (await constructed).failQualification = true;
  await assert.rejects(failing.qualify(), /witness failed/);
  assert.equal(failing.live(), false, 'failed witnesses retire the Worker');
  driver.retire();
});

test('dispatch observation resolves only for a transferred frame and rejects on retirement', async () => {
  const driver = new RetainedDriver();
  await assert.rejects(driver.nextDispatch(0), /opcode/);
  const session = driver.nextDispatch(1), never = driver.nextDispatch(99);
  await evaluate(driver);
  assert.equal(await session, 1);
  driver.retire();
  await assert.rejects(never, /retired/);
  await assert.rejects(driver.nextDispatch(1), /retired/);
});

// #8048: the loader deliberately remains blocked longer than the old fixed
// callback wait. Only the constructor acknowledgement identifies the new peer.
test('#8048 delayed startup injects the fault into its own transport', async () => {
  const previous = peers.at(-1);
  await holdStartup(true);
  const constructed = nextPeer();
  const driver = new RetainedDriver();
  try {
    await flush();
    assert.equal(peers.at(-1), previous, 'the old wait can still select the previous peer');
  } finally {
    await holdStartup(false);
  }
  const peer = await constructed;
  assert.notEqual(peer, previous);
  peer.wrongReply = true;
  await assert.rejects(evaluate(driver), /identity/);
  assert.equal(peer.retired, true);
  assert.equal(driver.live(), false);
});

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// #7955 / review 4383542900: construction must match native refusal cleanup.
test('#8184 construction known refusals release unpublished handles and preserve existing leases', async () => {
  for (const fault of ['resource', 'upload', 9, 10, 11]) {
    const driver = new RetainedDriver();
    const source = await evaluate(driver), peer = peers.at(-1);
    const before = new Set(peer.objects), start = peer.commands.length;
    if (fault === 'upload') peer.uploadStatus = 4;
    else if (fault !== 'resource') { peer.failOpcode = fault; peer.kernelStatus = 4; }
    await assert.rejects(evaluate(driver, 0, fault === 'resource' ? 8 : 4096),
      error => fault === 'resource' ? error.resourceLimit === true : error.kernelStatus === 4);
    assert.equal(driver.live(), true, `${fault}: synchronized refusal preserves worker`);
    assert.equal(driver.objectLive(source.object), true);
    assert.deepEqual(peer.objects, before, 'unpublished solid and temporary mesh released');
    assert.equal(opcodes(peer).slice(start).filter(op => op === 8).length, fault === 'upload' ? 0 : fault === 9 ? 1 : 2);
    peer.failOpcode = undefined;
    peer.uploadStatus = undefined;
    const next = await evaluate(driver);
    assert.equal(driver.objectLive(next.object), true, 'busy guard released; worker reusable');
    driver.retire();
  }
});

test('#8184 construction uncertain statuses and cleanup failures still retire the worker', async () => {
  for (const fault of ['upload', 'tessellate', 'cleanup']) {
    const driver = new RetainedDriver();
    const source = await evaluate(driver), peer = peers.at(-1), start = peer.commands.length;
    if (fault === 'upload') peer.uploadStatus = 8;
    else { peer.failOpcode = fault === 'cleanup' ? 8 : 9; peer.kernelStatus = fault === 'cleanup' ? 4 : 8; }
    await assert.rejects(evaluate(driver, 0, fault === 'cleanup' ? 8 : 4096),
      error => fault === 'cleanup' ? error.resourceLimit === true : error.kernelStatus === 8);
    assert.equal(driver.live(), false);
    assert.equal(driver.objectLive(source.object), false);
    assert.equal(peer.retired, true);
    if (fault === 'cleanup') assert.equal(opcodes(peer).slice(start).filter(op => op === 8).length, 1, 'failed release is never retried');
  }
});

test('#7955 E Boolean copies/releases its temporary before certifying and reading the result', async () => {
  const driver = new RetainedDriver();
  const a = await evaluate(driver), b = await evaluate(driver), peer = peers.at(-1);
  const start = peer.commands.length;
  const result = await driver.boolean(a.object, b.object, identity, 3, 0.001, 5, 4096);
  assert.deepEqual(opcodes(peer).slice(start), [17, 5, 8, 19, 9, 10, 11, 11, 11, 11, 8]);
  assert.equal(peer.objects.size, 3, 'two inputs and an independently owned result');
  driver.releaseObject(a.object); driver.releaseObject(b.object); await flush();
  assert.ok(driver.objectLive(result.object));
  assert.equal(peer.objects.size, 1);
  driver.retire();
});
test('#7955 E certified empty Boolean allocates no mesh and keeps an independent lease', async () => {
  const driver = new RetainedDriver(); const a = await evaluate(driver), peer = peers.at(-1);
  peer.empty = true; const start = peer.commands.length;
  const result = await driver.boolean(a.object, a.object, identity, 3, 0.001, 5, 4096);
  assert.equal(result.empty, true); assert.equal(result.mesh, null);
  assert.deepEqual(opcodes(peer).slice(start), [17, 5, 8, 19]);
  assert.equal(peer.objects.size, 2);
  driver.retire();
});
test('#7955 E affine failures preserve typed status and retire only after copy starts', async () => {
  for (const status of [1, 8, 99]) {
    const driver = new RetainedDriver(); const a = await evaluate(driver), peer = peers.at(-1);
    peer.failOpcode = 18; peer.kernelStatus = status;
    await assert.rejects(driver.affine(a.object, identity), error => error.kernelStatus === status);
    assert.equal(driver.live(), status === 1);
    assert.equal(driver.objectLive(a.object), status === 1);
    driver.retire();
  }
});
test('#7955 E affine copy and tessellation preserve input and output leases', async () => {
  const driver = new RetainedDriver(); const a = await evaluate(driver), peer = peers.at(-1);
  const start = peer.commands.length;
  const copy = await driver.affine(a.object, identity);
  assert.deepEqual(opcodes(peer).slice(start), [18]);
  const before = peer.objects.size;
  await driver.tessellate(copy.object, 0.001, 5, 4096);
  assert.equal(peer.objects.size, before, 'temporary mesh released');
  driver.releaseObject(a.object); await flush();
  assert.ok(driver.objectLive(copy.object));
  driver.retire();
});
test('#7955 E foreign leases and invalid limits submit no frames', async () => {
  const a = new RetainedDriver(), b = new RetainedDriver();
  const source = await evaluate(a); await evaluate(b); const peer = peers.at(-1);
  const count = peer.commands.length;
  await assert.rejects(b.affine(source.object, identity), /foreign/);
  await assert.rejects(b.tessellate(source.object, 0, 5, 4096), /limits/);
  assert.equal(peer.commands.length, count);
  a.retire(); b.retire();
});

test('#7955 E oversized buffers retain a resource refusal distinct from malformed wire', async () => {
  const driver = new RetainedDriver();
  const source = await evaluate(driver);
  const peer = peers.at(-1), start = peer.commands.length;
  await assert.rejects(driver.tessellate(source.object, 0.001, 5, 8), error => error.resourceLimit === true && error.kernelStatus === undefined);
  assert.equal(driver.live(), true);
  assert.equal(driver.objectLive(source.object), true);
  assert.equal(peer.objects.size, 1, 'only the input remains');
  assert.deepEqual(opcodes(peer).slice(start), [19, 9, 10, 8]);
  driver.retire();
});

test('#7955 E tessellation kernel refusals preserve the input and release any temporary mesh', async () => {
  for (const opcode of [19, 9, 10, 11]) {
    for (const status of [1, 2, 3, 4, 5, 6, 7, 8, 99]) {
      const driver = new RetainedDriver();
      const source = await evaluate(driver), peer = peers.at(-1);
      const start = peer.commands.length;
      peer.failOpcode = opcode; peer.kernelStatus = status;
      await assert.rejects(driver.tessellate(source.object, 0.001, 5, 4096), error => error.kernelStatus === status);
      const recoverable = status <= 7;
      assert.equal(driver.live(), recoverable);
      assert.equal(driver.objectLive(source.object), recoverable);
      if (recoverable) {
        assert.equal(peer.objects.size, 1, 'only the input remains');
        assert.equal(opcodes(peer).slice(start).includes(8), opcode === 10 || opcode === 11);
        peer.failOpcode = undefined;
        await driver.tessellate(source.object, 0.001, 5, 4096);
        assert.equal(peer.objects.size, 1, 'the input can still be tessellated');
      } else assert.equal(peer.retired, true);
      driver.retire();
    }
  }
});

// #7955 E: transactional refusal releases every intermediate without losing inputs.
test('#7955 E Boolean known refusals keep the worker and release temporary handles', async () => {
  for (const fault of ['kernel', 'resource', 'empty-status']) {
    const driver = new RetainedDriver();
    const a = await evaluate(driver), peer = peers.at(-1);
    const start = peer.commands.length;
    if (fault !== 'resource') { peer.failOpcode = fault === 'kernel' ? 5 : 19; peer.kernelStatus = 4; }
    await assert.rejects(driver.boolean(a.object, a.object, identity, 3, 0.001, 5, fault === 'resource' ? 8 : 4096),
      error => fault === 'resource' ? error.resourceLimit === true : error.kernelStatus === 4);
    assert.equal(driver.live(), true);
    assert.equal(driver.objectLive(a.object), true);
    assert.equal(peer.objects.size, 1, 'only the input remains, including after tessellation refusal');
    assert.ok(opcodes(peer).slice(start).includes(8), 'temporary released');
    if (fault === 'kernel') assert.deepEqual(opcodes(peer).slice(start), [17, 5, 8]);
    driver.retire();
  }
});


test('#7955 E2 construction faults clean unpublished handles and preserve typed evidence', async () => {
  for (const fault of ['kernel', 'resource', 'retiring']) {
    const driver = new RetainedDriver();
    const original = await evaluate(driver), peer = peers.at(-1);
    const before = peer.objects.size;
    if (fault !== 'resource') {
      peer.failOpcode = 10;
      peer.kernelStatus = fault === 'retiring' ? 8 : 4;
    }
    await assert.rejects(evaluate(driver, 0, fault === 'resource' ? 8 : 4096),
      error => fault === 'resource' ? error.resourceLimit === true : error.kernelStatus === peer.kernelStatus);
    assert.equal(driver.live(), fault !== 'retiring');
    assert.equal(driver.objectLive(original.object), fault !== 'retiring');
    if (fault !== 'retiring') {
      assert.equal(peer.objects.size, before, 'both unpublished mesh and solid released');
      peer.failOpcode = 0;
      const next = await evaluate(driver);
      assert.equal(driver.objectLive(next.object), true);
    }
    driver.retire();
  }
});
