/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import * as oracle from '../test/oracle/fingerprint.js';
import type { DataFingerprintInput, PropertyEntryInput } from './fingerprint.js';
const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);

test.skipIf(!existsSync(binary))('#8042 explicit batch matches unary oracle and never caches mutations', async () => {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const { buildFingerprintBatch } = await import('./internal.js');
  const sparse = new Array<PropertyEntryInput>(3);
  sparse[1] = { name: '\udfff', value: -Infinity };
  const inputs: DataFingerprintInput[] = [
    { ifcType: 'IfcWall' },
    { ifcType: 'IfcWall', name: '', propertySets: [], quantitySets: [], materials: [] },
    { ifcType: 'IfcWall\ud800', propertySets: [{ name: '__proto__', properties: [
      { name: 'nan', value: NaN }, { name: 'inf', value: Infinity }, { name: '-0', value: -0 },
      { name: 'text', value: '\ud800x\udfff' }, { name: 'nested', value: { z: 1, a: [false, null] } },
    ] }], typeAssignments: [{ type: '', name: '\ud800' }], materials: ['M', ''] },
    { ifcType: 'IfcWall', propertySets: [{ name: 'sparse', properties: sparse }], typeAssignments: new Array(2) },
  ];
  const expected = () => inputs.map(input => ({
    dataHash: oracle.buildDataFingerprint(input), components: oracle.buildComponentFingerprints(input),
  }));
  expect(buildFingerprintBatch(inputs)).toEqual(expected());
  inputs[0].name = 'changed';
  sparse[0] = { name: 'new', value: '\ud800' };
  expect(buildFingerprintBatch(inputs)).toEqual(expected());
  expect(buildFingerprintBatch([])).toEqual([]);
});

test.skipIf(!existsSync(binary))('#8042 batch preserves component projection getter order and sparse outer rejection', async () => {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const { buildFingerprintBatch } = await import('./internal.js');
  const run = (build: (input: DataFingerprintInput) => unknown) => {
    const reads: string[] = [];
    const input: DataFingerprintInput = {
      get ifcType() { reads.push('type'); return 'IfcWall'; },
      get propertySets() { reads.push('sets'); return [{ name: 'P', properties: [{
        get name() { reads.push('name'); return 'x'; },
        get value() { reads.push('value'); return 3; },
      }] }]; },
      get materials() { reads.push('materials'); return []; },
    };
    build(input); return reads;
  };
  expect(run(input => buildFingerprintBatch([input]))).toEqual(run(oracle.buildComponentFingerprints));
  const invalid = { ifcType: 'IfcWall', propertySets: new Array(2) };
  expect(() => buildFingerprintBatch([invalid])).toThrow(TypeError);
});


test.skipIf(!existsSync(binary))('#8042 bounded dense batches snapshot all adapters before native calls and keep oracle order', async () => {
  const { initDiffSync, diffModelConstructor } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const { buildFingerprintBatch } = await import('./internal.js');
  const { unpackDocument } = await import('./wasm-binary.js');
  const plain: DataFingerprintInput[] = Array.from({ length: 1025 }, (_, i) => ({
    ifcType: 'IfcWall', name: `row-${i}\ud800`,
    propertySets: [{ name: 'P', properties: [{ name: 'value', value: i }] }],
  }));
  const expected = plain.map(input => ({ dataHash: oracle.buildDataFingerprint(input),
    components: oracle.buildComponentFingerprints(input) }));
  let observed = 0;
  const inputs = plain.map(input => ({ ...input, get name() { observed++; return input.name; } }));
  const Model = diffModelConstructor();
  const native = Model.buildFingerprintBatch.bind(Model);
  let calls = 0;
  const instrument = vi.spyOn(Model, 'buildFingerprintBatch').mockImplementation(bytes => {
    expect(observed).toBe(inputs.length);
    const rows = unpackDocument(bytes);
    expect(Array.isArray(rows)).toBe(true);
    if (!Array.isArray(rows)) throw new Error('expected native row array');
    expect(rows.length).toBeLessThanOrEqual(512);
    calls++;
    return native(bytes);
  });
  try {
    expect(buildFingerprintBatch(inputs)).toEqual(expected);
    expect(calls).toBeGreaterThan(1);
  } finally { instrument.mockRestore(); }
  // Sparse collections retain their original whole-document checks.
  plain[513].typeAssignments = new Array(2);
  expect(buildFingerprintBatch(plain)).toEqual(plain.map(input => ({
    dataHash: oracle.buildDataFingerprint(input), components: oracle.buildComponentFingerprints(input),
  })));
});

test.skipIf(!existsSync(binary))('#8136 same-named sets keep one ordinal key each, unary and batch, in oracle order', async () => {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const { buildFingerprintBatch } = await import('./internal.js');
  const { buildComponentFingerprints } = await import('./wasm-fingerprint.js');
  const set = (name: string, value: unknown) => ({ name, properties: [{ name: 'p', value }] });
  const input: DataFingerprintInput = {
    ifcType: 'IfcWall',
    propertySets: [set('X', 2), set('X#2', 1), set('X', 1), set('2:X', 1), set('X', 3)],
    quantitySets: [{ name: 'Q', quantities: [{ name: 'a', value: 2 }] }, { name: 'Q', quantities: [{ name: 'a', value: 1 }] }],
  };
  const expected = Object.entries(oracle.buildComponentFingerprints(input));
  expect(expected.map(([key]) => key)).toEqual(
    ['attr:core', 'pset:2:X', 'pset:X', 'pset#2:X', 'pset#3:X', 'pset:X#2', 'qset:Q', 'qset#2:Q']);
  expect(Object.entries(buildComponentFingerprints(input))).toEqual(expected);
  expect(Object.entries(buildFingerprintBatch([input])[0].components)).toEqual(expected);
});
