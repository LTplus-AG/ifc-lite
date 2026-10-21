// SPDX-License-Identifier: MPL-2.0
// ifc-lite-wasm's private retained browser driver (js/retained-driver.mjs)
// against a protocol peer standing in for /smlib/. Lifetime and ordering only:
// this never qualifies geometry (the actual-Worker runs in
// rust/wasm-bindings/src/retained_browser/bridge_tests.rs do that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const fixtures = new URL('./lib/__fixtures__/retained-driver/', import.meta.url);
register(new URL('hooks.mjs', fixtures), { data: { peer: new URL('peer.mjs', fixtures).href } });
const { peers, imports } = await import(new URL('peer.mjs', fixtures));
const { RetainedDriver } = await import('../rust/wasm-bindings/js/retained-driver.mjs');

const flush = async () => { for (let i = 0; i < 50; i++) await new Promise((done) => setImmediate(done)); };
const evaluate = (driver, qualification = 0, maxBytes = 4096) =>
  driver.evaluate(new Uint8Array([7, 7]), 1, 1, 4, qualification, 0.001, 5, maxBytes);
const opcodes = (peer) => peer.commands.map(({ op }) => op);

test('importing the driver fetches no /smlib/ module; construction loads exactly the transport', async () => {
  assert.deepEqual(imports, []);
  const driver = new RetainedDriver();
  await flush();
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

test('response identity, oversize mesh and release failures retire the captured Worker', async () => {
  for (const fault of ['wrongReply', 'oversize', 'release']) {
    const driver = new RetainedDriver();
    if (fault === 'release') {
      const { object } = await evaluate(driver);
      const peer = peers.at(-1);
      peer.objects.clear();
      driver.releaseObject(object);
      await flush();
      assert.equal(driver.live(), false, fault);
      assert.equal(peer.retired, true);
      continue;
    }
    await flush();
    const peer = peers.at(-1);
    if (fault === 'wrongReply') peer.wrongReply = true;
    await assert.rejects(evaluate(driver, 0, fault === 'oversize' ? 8 : 4096), fault === 'wrongReply' ? /identity/ : /oversized/);
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
  const failing = new RetainedDriver();
  await flush();
  peers.at(-1).failQualification = true;
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
