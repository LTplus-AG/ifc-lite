/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkRetainedCallbacks, retainedCallbackSeams } from './retained-callback-cycles.mjs';

// Dedicated harness: a missing/stale production bundle cannot turn this into
// skipped ownership coverage. The root command always builds this feature.
const bundle = new URL('../../../packages/wasm/pkg-diff-decode-test/ifc-lite-diff.js', import.meta.url);
const wasm = await import(bundle.href);
wasm.initSync({ module: readFileSync(new URL('ifc-lite-diff_bg.wasm', bundle)) });
assert.equal(typeof wasm.diffTestExternrefLiveCount, 'function', 'build with --features decode-leak-test');
const methods = ['diffBuildDataFingerprint', 'diffBuildComponentFingerprints'];
// Large scalar strings exercise allocation cleanup without turning the leak
// check into a per-code-unit UTF-16 benchmark. Reuse below still has a lone unit.
const text = 'substantial decoded string '.repeat(256);
const entry = index => ({ name: `entry-${index}-${text}`, value: `value-${index}-${text}` });
const set = index => ({ name: `set-${index}-${text}`, properties: Array.from({ length: 4 }, (_, i) => entry(i)) });
const prefix = () => ({ ifcType: 'IfcWall', name: text, propertySets: [set(0), set(1)] });
const valid = { ifcType: 'IfcWall', name: 'valid \ud800', propertySets: [{ name: 'P', properties: [{ name: 'a', value: 'v' }] }] };
const expected = methods.map(method => wasm[method](valid));
function reject(object, key, raised) {
  Object.defineProperty(object, key, { get() { throw raised; }, configurable: true, enumerable: true });
  return object;
}
function throwsIdentically(run, raised, label) {
  let rejected = false;
  try { run(); } catch (actual) {
    rejected = true;
    assert.strictEqual(actual, raised, label);
  }
  assert.ok(rejected, `${label}: must reject`);
}
function nested(value) {
  const input = prefix();
  input.propertySets.push({ name: text, properties: [entry(0), { name: text, value }] });
  return input;
}
function byteLengthFailure(raised, throwOn, coercion) {
  let reads = 0;
  const value = new Uint8Array([1]);
  Object.defineProperty(value, 'length', { get() {
    // Reset on every rejection so all warm/repeated calls really reject.
    const current = reads++ % throwOn + 1;
    if (!coercion && current === throwOn) throw raised;
    return coercion ? { valueOf() { if (current === throwOn) throw raised; return 1; } } : 1;
  } });
  return value;
}
function iteratorCase(raised, failure) {
  let cursor = 0;
  const iterator = {
    next() {
      if (failure === 'next') throw raised;
      const step = { done: cursor++ > 0, value: text };
      if (failure === 'done' || failure === 'value') reject(step, failure, raised);
      if (failure === 'done conversion') step.done = { valueOf() { throw raised; } };
      return step;
    },
  };
  if (failure === 'next getter') reject(iterator, 'next', raised);
  return iterator;
}
function cases(raised) {
  const result = [];
  for (const key of ['ifcType', 'name', 'description', 'objectType', 'predefinedType', 'tag',
    'propertySets', 'quantitySets', 'typeAssignments', 'materials', 'classifications']) {
    result.push([`Input.${key}`, reject(prefix(), key, raised)]);
  }
  for (const [collection, member] of [['propertySets', 'properties'], ['quantitySets', 'quantities']]) {
    for (const key of ['name', member]) {
      const input = prefix();
      const good = { name: text, [member]: [entry(0), entry(1)] };
      input[collection] = [good, reject({ name: text, [member]: [] }, key, raised)];
      result.push([`${collection}.${key}`, input]);
    }
    for (const key of ['name', 'value']) {
      const input = prefix();
      input[collection] = [{ name: text, [member]: [entry(0), entry(1), reject(entry(2), key, raised)] }];
      result.push([`${collection}.Entry.${key}`, input]);
    }
  }
  for (const key of ['name', 'type']) {
    result.push([`TypeAssignment.${key}`, { ...prefix(),
      typeAssignments: [{ name: text, type: text }, reject({ name: text, type: text }, key, raised)] }]);
  }
  // Getter returns undefined, so the typed decoder's subsequent `in` must be
  // caught too. Both already-decoded records and the record handle are live.
  result.push(['typed missing-field has', { ...prefix(), typeAssignments: [new Proxy({}, {
    get() { return undefined; }, has() { throw raised; },
  })] }]);
  for (const field of ['materials', 'classifications']) {
    result.push([`${field} array member`, { ...prefix(), [field]: reject([text, text, text], 2, raised) }]);
    result.push([`${field} array length`, { ...prefix(), [field]: new Proxy([text], {
      get(target, key, receiver) {
        if (key === 'length') throw raised;
        return Reflect.get(target, key, receiver);
      },
    }) }]);
    result.push([`${field} iterator getter`, { ...prefix(), [field]: reject({}, Symbol.iterator, raised) }]);
    result.push([`${field} iterator call`, { ...prefix(), [field]: { [Symbol.iterator]() { throw raised; } } }]);
    for (const failure of ['next getter', 'next', 'done', 'done conversion', 'value']) {
      result.push([`${field} iterator ${failure}`, { ...prefix(), [field]: {
        [Symbol.iterator]() { return iteratorCase(raised, failure); },
      } }]);
    }
  }
  result.push(['nested array member', nested([text, { a: text }, reject([text, text], 1, raised)])]);
  result.push(['nested array length', nested([text, new Proxy([text], {
    get(target, key, receiver) {
      if (key === 'length') throw raised;
      return Reflect.get(target, key, receiver);
    },
  })])]);
  result.push(['nested object member', nested([text, { a: text }, reject({ a: text }, 'b', raised)])]);
  result.push(['nested object ownKeys', nested([text, new Proxy({ a: text }, {
    ownKeys() { throw raised; },
  })])]);
  result.push(['nested object descriptor', nested([text, new Proxy({ a: text }, {
    getOwnPropertyDescriptor() { throw raised; },
  })])]);
  result.push(['nested iterable has', nested([text, new Proxy({}, { has() { throw raised; } })])]);
  result.push(['nested member after failed cast probe', nested([text, new Proxy(reject({}, 'a', raised), {
    getPrototypeOf() { throw raised; },
  })])]);
  result.push(['nested byte-array length', nested([text, new Proxy(new Uint8Array(1), {
    get(target, key, receiver) {
      if (key === 'length') throw raised;
      return Reflect.get(target, key, receiver);
    },
  })])]);
  for (const read of [2, 3]) {
    for (const coercion of [false, true]) {
      result.push([`nested byte-array length ${read}/${coercion ? 'coercion' : 'getter'}`,
        nested([text, byteLengthFailure(raised, read, coercion)])]);
    }
  }
  result.push(['nested diagnostic function name', nested([text, reject(() => {}, 'name', raised)])]);
  result.push(['nested diagnostic tag', nested([text, reject(new Set(), Symbol.toStringTag, raised)])]);
  result.push(['nested Map iterator getter', nested([text, reject(new Map(), Symbol.iterator, raised)])]);
  for (const failure of ['next getter', 'next', 'done', 'done conversion', 'value', 'pair key', 'pair value']) {
    const map = new Map();
    map[Symbol.iterator] = () => {
      if (!failure.startsWith('pair')) return iteratorCase(raised, failure);
      return { next() { return { done: false, value: reject([text, text], failure === 'pair key' ? 0 : 1, raised) }; } };
    };
    result.push([`nested Map ${failure}`, nested([text, map])]);
  }
  return result;
}

test('getter rejection releases owned handles after decoded strings, then reuses the module (#8114)', () => {
  // Numbers and non-stringifiable objects must travel out of band too.
  for (const raised of [new Error('original getter error'), Symbol('original getter error'), 37,
    '\u0001host-type-error:spoofed', { toString() { throw new Error('do not stringify me'); } }]) {
    for (const [location, input] of cases(raised)) {
      for (const [methodIndex, method] of methods.entries()) {
        const rejectOnce = () => throwsIdentically(() => wasm[method](input), raised, `${method}/${location}`);
        // Warm preserve/serde/static-field caches before taking the invariant.
        for (let i = 0; i < 4; i++) {
          rejectOnce();
          assert.deepEqual(wasm[method](valid), expected[methodIndex]);
        }
        const baseline = wasm.diffTestExternrefLiveCount();
        for (let iteration = 0; iteration < 64; iteration++) {
          rejectOnce();
          assert.equal(wasm.diffTestExternrefLiveCount(), baseline,
            `${method}/${location}/${iteration}: rejection must release all owned externrefs`);
          assert.deepEqual(wasm[method](valid), expected[methodIndex], `${method}/${location}: same-module reuse`);
          assert.equal(wasm.diffTestExternrefLiveCount(), baseline,
            `${method}/${location}/${iteration}: valid reuse must release all owned externrefs`);
        }
      }
    }
  }
});

test('typed projection preserves field read order/count and ignores other record fields (#8114)', () => {
  for (const method of methods) {
    const reads = [];
    const track = (name, value) => new Proxy(value, {
      get(target, key, receiver) {
        reads.push(`${name}.${String(key)}`);
        if (key === 'ignored' || key === 'globalId') throw new Error('ignored field observed');
        return Reflect.get(target, key, receiver);
      },
      ownKeys() { throw new Error('typed records must not be enumerated'); },
    });
    const input = track('Input', { ifcType: 'IfcWall', name: 'Wall', description: 'D', objectType: 'O',
      predefinedType: 'P', tag: 'T',
      propertySets: [track('PropertySet', { name: 'P', properties: [track('Entry', { name: 'a', value: 1 })] })],
      quantitySets: [track('QuantitySet', { name: 'Q', quantities: [track('QuantityEntry', { name: 'a', value: 2 })] })],
      typeAssignments: [track('TypeAssignment', { name: 'WT', type: 'IfcWallType' })],
      materials: ['M'], classifications: ['C'],
    });
    wasm[method](input);
    assert.deepEqual(reads, ['Input.ifcType', 'Input.name', 'Input.description', 'Input.objectType',
      'Input.predefinedType', 'Input.tag', 'Input.propertySets', 'PropertySet.name', 'PropertySet.properties',
      'Entry.name', 'Entry.value', 'Input.quantitySets', 'QuantitySet.name', 'QuantitySet.quantities',
      'QuantityEntry.name', 'QuantityEntry.value', 'Input.typeAssignments', 'TypeAssignment.name',
      'TypeAssignment.type', 'Input.materials', 'Input.classifications']);
  }
});

test('failed instanceof cast probes keep the pinned binding behavior (#8114)', () => {
  const ordinary = { a: 'member' };
  const guarded = new Proxy(ordinary, { getPrototypeOf() { throw new Error('failed cast probe'); } });
  for (const method of methods) {
    assert.deepEqual(wasm[method](nested(guarded)), wasm[method](nested(ordinary)));
  }
});

test('byte-array copy observes three stable lengths with their u32 coercions (#8114)', () => {
  for (const [methodIndex, method] of methods.entries()) {
    const reads = [];
    const value = new Uint8Array([1]);
    Object.defineProperty(value, 'length', { get() {
      const read = reads.length / 2 + 1;
      reads.push(`get:${read}`);
      return { valueOf() { reads.push(`coerce:${read}`); return 1; } };
    } });
    let expectedError;
    try { wasm[method](nested(new Uint8Array([1]))); } catch (error) { expectedError = error; }
    assert.equal(typeof expectedError, 'string', 'ordinary bytes retain the unsupported-bytes diagnostic');
    const baseline = wasm.diffTestExternrefLiveCount();
    throwsIdentically(() => wasm[method](nested(value)), expectedError, `${method}/stable byte length`);
    assert.deepEqual(reads, ['get:1', 'coerce:1', 'get:2', 'coerce:2', 'get:3', 'coerce:3']);
    assert.equal(wasm.diffTestExternrefLiveCount(), baseline);
    assert.deepEqual(wasm[method](valid), expected[methodIndex]);
    assert.equal(wasm.diffTestExternrefLiveCount(), baseline);
  }
});

// Survival while retained and reclamation after release are separate phases.
// These are required tests of the fresh feature bundle, never optional GC skips.
for (const seam of retainedCallbackSeams) {
  test(`retained ${seam} callbacks survive and cyclic contexts reclaim (#8042, R134/R135)`, async context => {
    await checkRetainedCallbacks(wasm, seam, detail => context.diagnostic(JSON.stringify(detail)));
  });
}
