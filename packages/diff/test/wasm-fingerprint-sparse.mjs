/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8042: built public facade + actual WASM, compared with the private oracle.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const entry = new URL('../dist/index.js', import.meta.url);
const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
for (const artifact of [entry, binary]) {
  assert.ok(existsSync(artifact), `Missing ${artifact.pathname}; run root pnpm build before pnpm test.`);
}
const facade = await import(entry.href);
const { tsImport } = await import('tsx/esm/api');
const oracle = await tsImport('./oracle/fingerprint.ts', import.meta.url);
facade.initDiffSync({ module: readFileSync(binary) });
let comparisons = 0;
function outcome(implementation, operation, factory) {
  const trace = [];
  const input = factory(trace);
  try {
    const value = implementation[operation](input);
    // Component insertion order is observable, including duplicate key updates.
    return { value: typeof value === 'object' ? Object.entries(value) : value, trace };
  } catch (error) {
    return { error: error instanceof Error ? [error.constructor.name, error.message] : ['thrown', error], trace };
  }
}
function compare(id, factory) {
  for (const operation of ['buildDataFingerprint', 'buildComponentFingerprints']) {
    assert.deepEqual(outcome(facade, operation, factory), outcome(oracle, operation, factory), `${id}:${operation}`);
    comparisons++;
  }
}
const locations = ['propertySets', 'quantitySets', 'typeAssignments', 'properties', 'quantities'];
function record(location, trace, name = 'A') {
  const get = (key, value) => ({ enumerable: true, get() { trace.push(`${location}:${name}:${key}`); return value; } });
  const descriptors = { name: get('name', name) };
  if (location === 'propertySets') descriptors.properties = get('properties', []);
  else if (location === 'quantitySets') descriptors.quantities = get('quantities', []);
  else if (location === 'typeAssignments') descriptors.type = get('type', 'IfcWallType');
  else descriptors.value = get('value', Infinity);
  return Object.defineProperties({}, descriptors);
}
function slots(location, mode, trace) {
  if (mode === 'one-hole') return new Array(1);
  if (mode === 'two-holes') return new Array(2);
  if (mode === 'mixed') {
    const values = new Array(7);
    values[1] = record(location, trace, 'B'); values[3] = record(location, trace, 'A');
    values[5] = record(location, trace, 'A');
    return values;
  }
  if (mode === 'inherited') {
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, '0', { get() { trace.push('inherited:0'); return record(location, trace); } });
    return Object.setPrototypeOf(new Array(1), prototype);
  }
  if (mode === 'undefined') return [undefined];
  if (mode === 'null') return [null];
  return [record(location, trace, 'B'), record(location, trace, 'A')];
}
function inputFor(location, values, trace) {
  const collections = { propertySets: [], quantitySets: [], typeAssignments: [], materials: [], classifications: [] };
  if (location === 'properties') collections.propertySets = [{ name: 'P', properties: values }];
  else if (location === 'quantities') collections.quantitySets = [{ name: 'Q', quantities: values }];
  else collections[location] = values;
  const input = {};
  for (const [key, value] of Object.entries({ ifcType: 'IfcWall', name: '\ud800', ...collections })) {
    Object.defineProperty(input, key, { configurable: true, get() { trace.push(`input:${key}`); return value; } });
  }
  return input;
}
for (const location of locations) {
  for (const mode of ['one-hole', 'two-holes', 'mixed', 'dense', 'inherited', 'undefined', 'null']) {
    compare(`${location}:${mode}`, trace => inputFor(location, slots(location, mode, trace), trace));
  }
}
// One hole and no members have equal stableSerialize tokens ("[]"), but
// different JSON bytes. The stable duplicate-name sort must retain input order.
for (const kind of ['propertySets', 'quantitySets']) {
  const members = kind === 'propertySets' ? 'properties' : 'quantities';
  for (const reverse of [false, true]) {
    for (const populated of [false, true]) {
      compare(`tiebreak:${kind}:${reverse}:${populated}`, trace => {
        const prefix = populated ? [{ name: 'same', value: '\udfff' }] : [];
        const sparse = prefix.slice(); sparse.length++;
        const sets = [{ name: 'D', [members]: prefix }, { name: 'D', [members]: sparse },
          { name: 'D', [members]: new Array(2) }, { name: 'A', [members]: [] }];
        if (reverse) sets.reverse();
        return inputFor(kind, sets, trace);
      });
    }
  }
}
// Full map observation precedes the outer hole's component iteration error;
// later collection getters (including throwing ones) must remain untouched.
for (const kind of ['propertySets', 'quantitySets']) {
  compare(`outer-error-order:${kind}`, trace => {
    const values = new Array(2); values[1] = record(kind, trace);
    const input = inputFor(kind, values, trace);
    const later = kind === 'propertySets' ? 'quantitySets' : 'typeAssignments';
    Object.defineProperty(input, later, { configurable: true, get() { trace.push(`throw:${later}`); throw new RangeError('later'); } });
    return input;
  });
}
console.log(JSON.stringify({ protocol: 'wasm-fingerprint-sparse-8042', comparisons }));
