/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
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
