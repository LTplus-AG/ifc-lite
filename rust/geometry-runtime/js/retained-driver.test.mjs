// SPDX-License-Identifier: MPL-2.0
// Protocol/lifetime fixtures only. These are not SDK numerical qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function handle(slot) {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setBigUint64(0, 42n, true); view.setUint32(8, slot, true); view.setUint32(12, 1, true);
  return bytes;
}
async function fixture() {
  const peers = [], errors = [];
  class Transport {
    incarnation = Object.freeze({});
    objects = new Set();
    commands = [];
    slot = 0;
    witnesses = [];
    allocate() { const slot = ++this.slot; this.objects.add(slot); return handle(slot); }
    retire(token) { assert.equal(token, this.incarnation); this.retired = true; }
    async batch(frames) {
      return Promise.all(frames.map(async frame => {
        const owned = structuredClone(frame, { transfer: [frame] });
        const view = new DataView(owned), op = view.getUint32(8, true);
        this.commands.push({ op, view });
        if (op === this.fail) throw new Error(`fixture failure opcode ${op}`);
        let bytes = new Uint8Array(), status = 0;
        if (op === 1) { bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, 42n, true); }
        else if (op === 12) {
          bytes = new Uint8Array(8);
          new DataView(bytes.buffer).setUint32(0, 1, true);
          new DataView(bytes.buffer).setUint32(4, 48, true);
        } else if (op === 19) {
          bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, this.emptyQuery ?? 0, true);
        } else if (op === 18 && this.refuseAffine) {
          status = 7; bytes = new TextEncoder().encode("unsupported source class");
        } else if (op === 18) {
          assert.ok(this.objects.has(view.getUint32(28, true)));
          bytes = new Uint8Array(72);
          bytes.set(this.allocate());
          const cert = new DataView(bytes.buffer);
          cert.setUint32(16, 1, true); cert.setUint32(20, this.badCertificate ? 9 : 1, true);
          cert.setUint32(24 + 7*4, 6, true);
        } else if (op === 17) {
          assert.ok(this.objects.has(view.getUint32(28, true)));
          bytes = this.allocate();
        } else if (op === 5) {
          assert.ok(this.objects.has(view.getUint32(28, true)));
          assert.ok(this.objects.has(view.getUint32(44, true)));
          bytes = this.aliasBoolean ? handle(view.getUint32(28, true)) : this.allocate();
        } else if (op === 8) {
          assert.ok(this.objects.delete(view.getUint32(28, true)));
          if (this.holdRelease) await new Promise(resolve => { this.release = resolve; });
        } else if (op === 9) { bytes = this.allocate(); }
        else if (op === 10) {
          bytes = new Uint8Array(24);
          (this.meshInfo ?? [4,4,4,0,0,0]).forEach((n, i) => new DataView(bytes.buffer).setUint32(i * 4, n, true));
        } else if (op === 11) {
          const stream = view.getUint32(36, true), count = view.getUint32(44, true);
          const width = [1,4].includes(stream) ? 8 : 4;
          bytes = new Uint8Array(count * width); // finite fixture values within bounds
        } else throw new Error(`unexpected fixture opcode ${op}`);
        const response = new Uint8Array(12 + bytes.length), envelope = new DataView(response.buffer);
        envelope.setUint32(0, 1, true); envelope.setUint32(4, view.getUint32(4, true), true);
        envelope.setInt32(8, status, true);
        response.set(bytes, 12);
        return response.buffer;
      }));
    }
    constructor() { peers.push(this); }
  }
  const context = createContext({ Uint8Array, Float64Array, Uint32Array, ArrayBuffer, DataView, TextDecoder,
    console: { error: (...args) => errors.push(args) } });
  const modules = new Map();
  const exports = {
    '/smlib/client.mjs': { SmlibWorkerTransport: Transport },
    '/smlib/sweep.mjs': { uploadSweep: async transport => {
      const peer = peers.find(peer => peer.incarnation === transport.incarnation);
      const bytes = peer.allocate();
      (peer.uploads ??= []).push(new DataView(bytes.buffer).getUint32(8, true));
      return { bytes };
    } },
    '/smlib/sweep-contract.mjs': { runSweepContract: async transport => transport.witnesses.push('sweep') },
    '/smlib/contract.mjs': { runContract: async batch => {
      // Exercise the supplied actual transport closure, without geometry claims.
      await batch([new Uint8Array([1,0,0,0, 1,0,0,0, 1,0,0,0]).buffer]);
      peers.at(-1).witnesses.push('dependency');
    } },
  };
  const driver = new SourceTextModule(await readFile(new URL('./retained-driver.mjs', import.meta.url), 'utf8'), {
    context,
    importModuleDynamically: async specifier => {
      if (!modules.has(specifier)) {
        assert.ok(exports[specifier], specifier);
        const module = new SyntheticModule(Object.keys(exports[specifier]), function () {
          for (const [key, value] of Object.entries(exports[specifier])) this.setExport(key, value);
        }, { context });
        await module.link(() => { throw new Error('unexpected fixture import'); });
        await module.evaluate();
        modules.set(specifier, module);
      }
      return modules.get(specifier);
    },
  });
  await driver.link(() => { throw new Error('unexpected static import'); });
  await driver.evaluate();
  return { Driver: driver.namespace.RetainedDriver, peers, errors };
}
const evaluate = driver => driver.evaluate(new Uint8Array([1]), 1, 1, 4, 0, 0.001, 5, 1024);
const boolean = (driver, a, b, matrix = identity) => driver.evaluateBoolean(a.object, b.object, matrix, 3, 0.001, 5, 1024);

test('driver fixture: immutable ordered Boolean operands and independent result lease', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver();
  await driver.qualifyDependencies();
  assert.deepEqual(peers[0].witnesses, ['sweep', 'dependency']);
  const a = await evaluate(driver), b = await evaluate(driver);
  const matrix = [...identity]; matrix[12] = 0.5;
  const pending = boolean(driver, a, b, matrix);
  matrix[12] = 99; // capture before the first await, not after caller mutation
  const result = await pending, peer = peers[0];
  const copy = peer.commands.find(c => c.op === 17);
  assert.equal(copy.view.getUint32(28, true), peer.uploads[1]);
  assert.equal(copy.view.getFloat64(36 + 12 * 8, true), 0.5);
  const operation = peer.commands.find(c => c.op === 5);
  assert.equal(operation.view.getUint32(52, true), 3);
  assert.equal(operation.view.getUint32(28, true), peer.uploads[0]);
  assert.notEqual(operation.view.getUint32(28, true), operation.view.getUint32(44, true));
  driver.releaseObject(a.object); driver.releaseObject(b.object);
  assert.equal(driver.objectLive(a.object), false);
  assert.equal(driver.objectLive(b.object), false);
  assert.equal(driver.objectLive(result.object), true);
  // Next operation waits for queued healthy cleanup rather than failing busy.
  const next = await boolean(driver, result, result);
  driver.releaseObject(result.object); driver.releaseObject(next.object);
  await flush();
  assert.equal(peer.objects.size, 0);
  assert.equal(driver.live(), true);
  driver.retire();
});

test('driver fixture: foreign, unsupported frame and qualification rejections are intact', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver(), foreign = new Driver();
  const a = await evaluate(driver), b = await evaluate(foreign);
  await assert.rejects(boolean(driver, a, a), /unqualified/);
  await driver.qualifyDependencies();
  const count = peers[0].commands.length;
  await assert.rejects(boolean(driver, a, b), /foreign/);
  const scaled = [...identity]; scaled[0] = 2;
  await assert.rejects(boolean(driver, a, a, scaled), /nonrigid/);
  const reflected = [...identity]; reflected[0] = -1;
  await assert.rejects(boolean(driver, a, a, reflected), /reflected/);
  const nonfinite = [...identity]; nonfinite[12] = Infinity;
  await assert.rejects(boolean(driver, a, a, nonfinite), /proper rigid/);
  assert.equal(peers[0].commands.length, count);
  assert.equal(driver.objectLive(a.object), true);
  assert.equal(foreign.objectLive(b.object), true);
  driver.retire(); foreign.retire();
});

test('driver fixture: invalidate exact lease before delayed release; replacement survives failure', async () => {
  const { Driver, peers, errors } = await fixture();
  const driver = new Driver(), replacement = new Driver();
  const a = await evaluate(driver), b = await evaluate(driver);
  const other = await evaluate(replacement), peer = peers[0];
  peer.holdRelease = true;
  driver.releaseObject(a.object);
  assert.equal(driver.objectLive(a.object), false);
  assert.equal(driver.objectLive(b.object), true);
  assert.equal(driver.live(), true);
  peer.holdRelease = false; peer.release();
  await flush();
  peer.fail = 8;
  driver.releaseObject(b.object);
  await flush();
  assert.equal(driver.live(), false);
  assert.equal(replacement.objectLive(other.object), true);
  assert.equal(errors.length, 1);
  replacement.retire();
});

test('driver fixture: unknown Boolean outcome retires only its captured owner and preserves primary error', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver();
  await driver.qualifyDependencies();
  const a = await evaluate(driver), b = await evaluate(driver);
  const replacement = new Driver();
  await evaluate(replacement);
  peers[0].fail = 5;
  await assert.rejects(boolean(driver, a, b), /fixture failure opcode 5/);
  assert.equal(driver.live(), false);
  assert.equal(driver.objectLive(a.object), false);
  assert.equal(replacement.live(), true);
  driver.retire(); replacement.retire();
});


test('driver fixture: source qualification cannot grant the dependency gate', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver();
  await driver.qualify();
  assert.deepEqual(peers[0].witnesses, ['sweep']);
  const a = await evaluate(driver);
  await assert.rejects(boolean(driver, a, a), /unqualified retained dependencies/);
  assert.equal(driver.objectLive(a.object), true);
  assert.equal(driver.live(), true);
  driver.retire();
});


test('driver fixture: a returned wire alias cannot mint an independent result lease', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver();
  await driver.qualifyDependencies();
  const a = await evaluate(driver), b = await evaluate(driver);
  peers[0].aliasBoolean = true;
  await assert.rejects(boolean(driver, a, b), /aliases live input lease/);
  assert.equal(driver.live(), false);
});

// Fault peers check refusal/retirement only, never prove SDK emptiness.
test('driver fixture: zero or malformed meshes need matching actual-query classification', async () => {
  for (const [query, info] of [
    [0, [0,0,0,0,0,0]], [1, [4,0,0,0,0,0]], [1, [0,4,0,0,0,0]],
    [1, [0,0,4,0,0,0]], [1, [0,0,0,1,0,0]], [1, [0,0,0,0,1,0]],
    [1, [0,0,0,0,0,1]], [0, [4,4,4,0,0,1]], [2, [0,0,0,0,0,0]],
  ]) {
    const { Driver, peers } = await fixture();
    const driver = new Driver(); await driver.qualifyDependencies();
    const a = await evaluate(driver), b = await evaluate(driver);
    peers[0].emptyQuery = query; peers[0].meshInfo = info;
    await assert.rejects(boolean(driver, a, b), /invalid/);
    assert.equal(driver.live(), false);
    assert.equal(driver.objectLive(a.object), false);
  }
});

test('driver fixture: construction refuses certified empty rather than widening source admission', async () => {
  const { Driver, peers } = await fixture(); const driver = new Driver();
  await driver.qualifyDependencies(); peers[0].emptyQuery = 1;
  await assert.rejects(evaluate(driver), /empty retained construction/);
  assert.equal(driver.live(), false);
});


test('affine transport fixture: exact matrix payload, independent object and certificate', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver(), source = await evaluate(driver);
  const matrix = [-2,0,0,0, 0.4,3,0,0, 0.2,0.3,4,0, 7,-4,2,1];
  const pending = driver.copyAffine(source.object, matrix);
  matrix[0] = 99; // Driver owns inputs before its first await.
  const result = await pending, peer = peers[0];
  const issued = peer.commands.find(command => command.op === 18);
  assert.equal(issued.view.getFloat64(36, true), -2);
  assert.equal(result.certificate.byteLength, 56);
  assert.notEqual(source.object, result.object);
  driver.releaseObject(source.object); await flush();
  assert.equal(driver.objectLive(source.object), false);
  assert.equal(driver.objectLive(result.object), true);
  assert.equal(peer.retired, undefined);
  driver.releaseObject(result.object); await flush();
  assert.equal(driver.live(), true);
  driver.retire();
});

test('affine transport fixture: invalid matrix is unsent; malformed certificate retires domain', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver(), source = await evaluate(driver), peer = peers[0];
  const before = peer.commands.length;
  const singular = identity.slice(); singular[10] = 0;
  await assert.rejects(driver.copyAffine(source.object, singular), /singular/);
  assert.equal(peer.commands.length, before);
  assert.equal(driver.objectLive(source.object), true);
  peer.badCertificate = true;
  await assert.rejects(driver.copyAffine(source.object, identity), /certificate/);
  assert.equal(driver.objectLive(source.object), false);
  assert.equal(peer.retired, true);
});


test('affine transport fixture: synchronized representation refusal preserves independent leases', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver(), source = await evaluate(driver), peer = peers[0];
  peer.refuseAffine = true;
  await assert.rejects(driver.copyAffine(source.object, identity), /unsupported source class/);
  assert.equal(driver.objectLive(source.object), true);
  assert.equal(peer.retired, undefined);
  peer.refuseAffine = false;
  const result = await driver.copyAffine(source.object, identity);
  assert.equal(driver.objectLive(result.object), true);
  driver.retire();
});
