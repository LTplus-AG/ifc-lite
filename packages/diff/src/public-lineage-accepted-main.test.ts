/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as oracle from '../test/oracle/lineage.js';
import type { LineageEntry, RekeyPolicy } from './lineage.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
const builtEntry = new URL('../dist/index.js', import.meta.url);
const policies: RekeyPolicy[] = ['copy-to-all', 'largest-share', 'orphan-on-split'];
// Exact accepted #8084 numeric matrix, supplied live: JSON would erase NaN/Infinity.
const invalidShares = [
  undefined, [], [0.6], [0.2, 0.6, 0.2],
  [NaN, 0.6], [0.6, NaN], [Infinity, 0.6], [0.6, Infinity],
  [-Infinity, 0.6], [0.6, -Infinity], [-0.1, 0.6], [0.6, -0.1],
  [0.5, 0.5], [0, 0],
];
const cases = [
  ...invalidShares.map((shares, index) => ({ name: `invalid-${index}`, shares, valid: false })),
  ...[[0, 1], [2, 6], [0.4, 0.6]].map((shares, index) => ({ name: `valid-${index}`, shares, valid: true })),
];
function split(shares: number[] | undefined, source = 'source', head = ['a', 'b']): LineageEntry {
  return { base: [source], head, relation: 'split', reason: 'split:verified', shares: shares?.slice() };
}

for (const entry of ['source', 'built'] as const) {
  for (const { name, shares, valid } of cases) {
    test(`initialized ${entry} public largest-share accepted #8131/#8084 ${name} (#8042)`, async (context) => {
      if (!existsSync(binary) || !existsSync(glue)) {
        context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
        return;
      }
      if (entry === 'built' && !existsSync(builtEntry)) {
        context.skip('Optional built public artifact missing; run root pnpm build, then root pnpm test --filter=@ifc-lite/diff');
        return;
      }
      const api: typeof import('./index.js') = entry === 'source'
        ? await import('./index.js') : await import(builtEntry.href);
      api.initDiffSync({ module: readFileSync(binary) });
      for (const policy of policies) {
        const successors = policy === 'copy-to-all' ? ['a', 'b']
          : policy === 'largest-share' && valid ? ['b'] : [];
        const expected = [{ key: 'source', successors, relation: 'split', orphan: successors.length === 0 }];
        expect(oracle.rekeyByLineage(['source'], [split(shares)], policy)).toEqual(expected);
        expect(api.rekeyByLineage(['source'], [split(shares)], policy)).toEqual(expected);
      }
    });
  }

  test(`${entry} public accepted policy retains UTF-16, first entry wins, omission and pass-through (#8042, #8084)`, async (context) => {
    if (!existsSync(binary) || !existsSync(glue)) {
      context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
      return;
    }
    if (entry === 'built' && !existsSync(builtEntry)) {
      context.skip('Optional built public artifact missing; run root pnpm build, then root pnpm test --filter=@ifc-lite/diff');
      return;
    }
    const api: typeof import('./index.js') = entry === 'source'
      ? await import('./index.js') : await import(builtEntry.href);
    api.initDiffSync({ module: readFileSync(binary) });
    const keys = ['\ud800', '\ufffd', 'literal\\ud800'];
    for (const key of keys) {
      function lineage() {
        return { entries: [split([NaN, 0.6], key), split([0, 1], key)], deleted: ['gone'] };
      }
      for (const policy of policies) {
        const successors = policy === 'copy-to-all' ? ['a', 'b'] : [];
        const expected = [
          { key, successors, relation: 'split', orphan: successors.length === 0 },
          { key: 'gone', successors: [], orphan: true },
          { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
        ];
        const actual = api.rekeyByLineage([key, 'gone', 'same'], lineage(), policy);
        expect(actual).toEqual(expected);
        expect(actual).toEqual(oracle.rekeyByLineage([key, 'gone', 'same'], lineage(), policy));
        expect(Object.hasOwn(actual[1], 'relation')).toBe(false);
      }
    }
    for (const shares of [undefined, []]) {
      const expected = [{ key: 'source', successors: [], relation: 'split', orphan: true }];
      expect(api.rekeyByLineage(['source'], [split(shares, 'source', [])], 'largest-share')).toEqual(expected);
      expect(oracle.rekeyByLineage(['source'], [split(shares, 'source', [])], 'largest-share')).toEqual(expected);
    }
  });
}
