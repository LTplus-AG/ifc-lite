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
          new DataView(bytes.buffer).setUint32(4, this.capabilities ?? 112, true);
        } else if (op === 19) {
          bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, this.emptyQuery ?? 0, true);
        } else if (op === 20 && this.refusePlane) {
          status = this.refusePlane; bytes = new TextEncoder().encode('plane fixture refusal');
        } else if (op === 20) {
          // Structural template only. Never supplies an SDK geometry oracle.
          assert.equal(owned.byteLength, 92);
          const count = this.cylinders ?? 0;
          bytes = new Uint8Array(312 + 136*count);
          bytes.set(this.allocate()); bytes.set(new Uint8Array(owned, 20, 16), 32); bytes.set(bytes.slice(0, 16), 48);
          const cert = new DataView(bytes.buffer), set = (i, v) => cert.setUint32(i, v, true);
          for (const [i, v] of [[16,1],[20,count ? 5 : 1],[24,1],[64,view.getUint32(84,true)],
            [68,view.getUint32(88,true)],[72,6],[76,12],[80,64],[308,count]]) set(i, v);
          bytes.set(new Uint8Array(owned, 36, 48), 84);
          const sign = view.getInt32(84, true)*(view.getUint32(88,true) === 3 ? -1 : 1);
          // This template is restricted to a +/-Z request normal.
          for (const [base, values] of [[132,[1,0,0,0,sign,0,0,0,sign]],
            [204,[-1,-1,0,1,1,1]],[252,[-2,-2,0,2,2,2]]])
            values.forEach((v,i) => cert.setFloat64(base+8*i,v,true));
          cert.setFloat64(300, 1e-6, true);
          for (let i = 0; i < count; i++) {
            const base = 312+136*i;
            set(base, i);
            [0,4,8].forEach(j => cert.setFloat64(base+40+8*j,1,true));
            cert.setFloat64(base+112,1,true); cert.setFloat64(base+128,1,true);
          }
          if (this.corruptPlane) this.corruptPlane(bytes, cert);
        } else if (op === 18 && this.refuseAffine) {
          status = this.refuseAffine; bytes = new TextEncoder().encode("unsupported source class");
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
  peer.refuseAffine = 7;
  await assert.rejects(driver.copyAffine(source.object, identity), /unsupported source class/);
  assert.equal(driver.objectLive(source.object), true);
  assert.equal(peer.retired, undefined);
  peer.refuseAffine = false;
  const result = await driver.copyAffine(source.object, identity);
  assert.equal(driver.objectLive(result.object), true);
  driver.retire();
});


test('affine transport fixture: tainted kernel status retires the captured worker', async () => {
  const { Driver, peers } = await fixture();
  const driver = new Driver(), source = await evaluate(driver), peer = peers[0];
  peer.refuseAffine = 8;
  await assert.rejects(driver.copyAffine(source.object, identity), /retained status 8/);
  assert.equal(driver.objectLive(source.object), false);
  assert.equal(peer.retired, true);
});

const clip = (driver, source, plane = [0,0,0.5,0,0,1], side = 1, mode = 2) =>
  driver.clipPlane(source.object, plane, side, mode, 0.001, 5, 1024);

test('plane protocol fixture: own exact coefficients before await; frozen result and independent cleanup', async () => {
  const { Driver, peers } = await fixture(); const driver = new Driver(), source = await evaluate(driver);
  const plane = [-0,0,0.5,0,0,1], pending = clip(driver, source, plane);
  plane[2] = 99;
  const result = await pending, issued = peers[0].commands.find(c => c.op === 20);
  assert.equal(issued.view.byteLength, 92); assert.equal(issued.view.getFloat64(52, true), 0.5);
  assert.ok(Object.is(issued.view.getFloat64(36, true), -0));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.certificate));
  assert.ok(Object.isFrozen(result.input)); assert.ok(Object.isFrozen(result.mesh));
  assert.ok(Object.isFrozen(result.mesh.positions));
  assert.throws(() => { result.certificate[0] = 99; }, TypeError);
  driver.releaseObject(source.object);
  const chained = await clip(driver, result);
  driver.releaseObject(result.object); await flush();
  assert.equal(driver.objectLive(chained.object), true);
  driver.releaseObject(chained.object); await flush();
  assert.equal(peers[0].objects.size, 0); assert.equal(driver.live(), true); driver.retire();
});

test('plane rejection fixtures: exact identity, frame, finite domain and cylinder bounds', async () => {
  const mutations = [
    (b,v) => v.setUint32(16,2,true), (b,v) => v.setUint32(20,8,true),
    (b,v) => v.setUint32(24,0,true), (b,v) => v.setUint32(28,2,true),
    (b,v) => v.setUint32(32,43,true), (b,v) => v.setUint32(44,0,true),
    (b,v) => v.setUint32(48,43,true), (b,v) => v.setUint32(60,0,true),
    (b,v) => v.setUint32(64,0xffffffff,true), (b,v) => v.setUint32(68,3,true),
    (b,v) => v.setUint32(72,100001,true), (b,v) => v.setUint32(76,100001,true),
    (b,v) => v.setUint32(80,1000001,true), (b,v) => v.setUint32(308,17,true),
    (b,v) => v.setFloat64(84,-0,true), (b,v) => v.setFloat64(132,NaN,true),
    (b,v) => v.setFloat64(204,2,true), (b,v) => v.setFloat64(252,2,true),
    (b,v) => v.setFloat64(300,0,true), (b,v) => v.setUint32(20,0,true),
    (b,v) => v.setUint32(312,6,true), (b,v) => v.setUint32(316,2,true),
    (b,v) => v.setUint32(320,2,true), (b,v) => v.setUint32(324,1,true),
    (b,v) => v.setFloat64(328,Infinity,true), (b,v) => v.setFloat64(424,0,true),
    (b,v) => v.setFloat64(432,1,true), (b,v) => v.setFloat64(440,NaN,true),
  ];
  for (const mutation of mutations) {
    const { Driver, peers } = await fixture(); const driver = new Driver(), source = await evaluate(driver);
    peers[0].cylinders = 1; peers[0].corruptPlane = mutation;
    await assert.rejects(clip(driver, source));
    assert.equal(driver.live(), false); assert.equal(driver.objectLive(source.object), false);
  }
});

test('plane refusal fixtures: unsupported capability/status7 preserve inputs; taint8 retires', async () => {
  const { Driver, peers } = await fixture(); const driver = new Driver(), source = await evaluate(driver), peer = peers[0];
  peer.capabilities = 48;
  await assert.rejects(clip(driver, source), /unavailable/);
  assert.equal(peer.commands.some(c => c.op === 20), false); assert.equal(driver.objectLive(source.object), true);
  peer.capabilities = 112; peer.refusePlane = 7;
  await assert.rejects(clip(driver, source), /fixture refusal/); assert.equal(driver.objectLive(source.object), true);
  peer.refusePlane = 8;
  await assert.rejects(clip(driver, source), /fixture refusal/); assert.equal(driver.live(), false);
});

test('plane fixture: foreign/invalid inputs unsent; output semantic-query mismatch retires', async () => {
  const { Driver, peers } = await fixture(); const driver = new Driver(), foreign = new Driver();
  const source = await evaluate(driver), other = await evaluate(foreign), count = peers[0].commands.length;
  await assert.rejects(clip(driver, other), /foreign/);
  await assert.rejects(clip(driver, source, [0,0,0,0,0,0]), /invalid/);
  assert.equal(peers[0].commands.length, count); assert.equal(driver.objectLive(source.object), true);
  peers[0].emptyQuery = 1; peers[0].meshInfo = [0,0,0,0,0,0];
  await assert.rejects(clip(driver, source), /classification mismatch/);
  assert.equal(driver.live(), false); assert.equal(foreign.objectLive(other.object), true); foreign.retire();
});

test('plane lifetime fixture: pending release generations cannot alias newly accepted output', async () => {
  const { Driver, peers } = await fixture(); const driver = new Driver();
  const source = await evaluate(driver), sibling = await evaluate(driver), peer = peers[0];
  const siblingSlot = peer.uploads[1];
  peer.corruptPlane = (bytes, view) => {
    // Driver is busy here: dropping a sibling queues its exact generation.
    driver.releaseObject(sibling.object);
    bytes.set(handle(siblingSlot)); bytes.set(handle(siblingSlot), 48);
  };
  await assert.rejects(clip(driver, source), /aliases live input lease/);
  assert.equal(driver.live(), false);
});
