/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as oracle from '../test/oracle/lineage.js';
import type { LineageEntry } from './lineage.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
type Rekey = typeof oracle.rekeyByLineage;
const orphan = [{ key: 's', successors: [], relation: 'split', orphan: true }];

test('public accepted every short-circuit and retained callback preserve host values (#8042, #8131)', async (context) => {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
    return;
  }
  const api = await import('./index.js');
  api.initDiffSync({ module: readFileSync(binary) });
  function run(rekey: Rekey) {
    const log: string[] = [];
    let retained: ((share: unknown) => boolean) | undefined;
    let headReads = 0;
    const shares = [0.1, 0.9];
    Object.defineProperty(shares, 'every', { value(callback: (share: unknown) => boolean) {
      log.push('every'); retained = callback; return 0;
    } });
    Object.defineProperty(shares, 'filter', { value() { throw new Error('must short-circuit filter'); } });
    const entry: LineageEntry = { base: ['s'], reason: '', relation: 'split', shares,
      get head() {
        if (++headReads > 1) throw new Error('must short-circuit successor head');
        return ['x', 'y'];
      } };
    const rows = rekey(['s'], [entry], 'largest-share');
    // Invoke after the public call returned. A Rust callback must remain alive.
    const later = [0, -0, 0.9, -1, NaN, Infinity, -Infinity, '1', null, 1n, Symbol()]
      .map(value => retained?.(value));
    return { rows, log, headReads, later };
  }
  const expected = run(oracle.rekeyByLineage);
  expect(run(api.rekeyByLineage)).toEqual(expected);
  expect(expected).toEqual({ rows: orphan, log: ['every'], headReads: 1,
    later: [true, true, true, false, false, false, false, false, false, false, false] });
});

test('public guard keeps sparse holes and inherited indices observable (#8042, #8131)', async (context) => {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
    return;
  }
  const api = await import('./index.js');
  api.initDiffSync({ module: readFileSync(binary) });
  for (const inherited of [false, true]) {
    // Each iteration captures its own inherited-versus-own shares fixture (#8042).
    // eslint-disable-next-line no-inner-declarations
    function run(rekey: Rekey) {
      const shares = Array<number>(2);
      shares[1] = 0.9;
      if (inherited) {
        const prototype = Object.create(Array.prototype) as number[];
        prototype[0] = -1;
        Object.setPrototypeOf(shares, prototype);
      }
      return rekey(['s'], [{ base: ['s'], head: ['x', 'y'], relation: 'split', reason: '', shares }], 'largest-share');
    }
    const expected = inherited ? orphan : [{ key: 's', successors: ['x'], relation: 'split', orphan: false }];
    expect(run(oracle.rekeyByLineage)).toEqual(expected);
    expect(run(api.rekeyByLineage)).toEqual(expected);
  }
});

test('public guard propagates every getter exception and closes keys (#8042, #8131)', async (context) => {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
    return;
  }
  const api = await import('./index.js');
  api.initDiffSync({ module: readFileSync(binary) });
  const sentinel = new RangeError('every getter \ud800');
  for (const rekey of [oracle.rekeyByLineage, api.rekeyByLineage]) {
    const log: string[] = [];
    const shares = [0.1, 0.9];
    Object.defineProperty(shares, 'every', { get() { log.push('every'); throw sentinel; } });
    // This iterator captures the current observation log for IteratorClose (#8042).
    // eslint-disable-next-line no-inner-declarations
    function* keys() { try { yield 's'; } finally { log.push('closed'); } }
    try {
      rekey(keys(), [{ base: ['s'], head: ['x', 'y'], relation: 'split', reason: '', shares }], 'largest-share');
      expect.unreachable('every getter must throw');
    } catch (error) { expect(error).toBe(sentinel); }
    expect(log).toEqual(['every', 'closed']);
  }
});
