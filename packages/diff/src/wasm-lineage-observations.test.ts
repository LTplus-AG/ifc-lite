/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, expect, test } from 'vitest';
import * as oracle from '../test/oracle/lineage.js';
import type { Lineage, LineageEntry, RekeyPolicy, RekeyResult } from './lineage.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const wasmTest = test;
beforeEach((context) => {
  if (!existsSync(binary) || !existsSync(new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url))) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
  }
});
const policies: RekeyPolicy[] = ['copy-to-all', 'largest-share', 'orphan-on-split'];
async function adapter() {
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  return import('./wasm-lineage.js');
}
/** Access traces compare actual WASM with the retained TS behavior. */
function observed<T extends object>(value: T, log: string[]): T {
  const cache = new WeakMap<object, object>();
  function wrap<U extends object>(target: U, path: string): U {
    const cached = cache.get(target);
    if (cached) return cached as U;
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        log.push(`${path}.${String(key)}`);
        const result: unknown = Reflect.get(object, key, receiver);
        return result !== null && typeof result === 'object' ? wrap(result, `${path}.${String(key)}`) : result;
      },
      has(object, key) { log.push(`${path}.has(${String(key)})`); return Reflect.has(object, key); },
    });
    cache.set(target, proxy);
    return proxy;
  }
  return wrap(value, 'root');
}
function ordered(rows: RekeyResult[]) {
  return { rows, keys: rows.map(row => Object.keys(row)), json: JSON.stringify(rows) };
}

wasmTest('lineage ignores cyclic/function/symbol/BigInt extras and unused throwing fields; inherited UTF-16 fields work (#8042)', async () => {
  const facade = await adapter();
  const sentinel = new Error('unused field');
  const inherited: LineageEntry = Object.create({
    base: ['b\ud800'], head: ['h\udfff'], relation: 'identity',
    get reason() { throw sentinel; }, get shares() { throw sentinel; },
  });
  Object.assign(inherited, { extra: inherited, fn: () => 1, symbol: Symbol('extra'), bigint: 1n });
  const split: LineageEntry = {
    base: ['s'], head: ['x', 'y'], relation: 'split',
    get reason(): string { throw sentinel; }, get shares(): number[] { throw sentinel; },
  };
  for (const entries of [[inherited], [inherited, inherited], [split]]) {
    expect(facade.lineageConflicts(entries)).toEqual(oracle.lineageConflicts(entries));
    expect([...facade.keyAliasesFromLineage(entries)]).toEqual([...oracle.keyAliasesFromLineage(entries)]);
  }
  for (const policy of policies) {
    expect(ordered(facade.rekeyByLineage(['b\ud800', 'gone', 'other'], { entries: [inherited, split], deleted: ['gone'] }, policy)))
      .toEqual(ordered(oracle.rekeyByLineage(['b\ud800', 'gone', 'other'], { entries: [inherited, split], deleted: ['gone'] }, policy)));
  }
  for (const policy of ['copy-to-all', 'orphan-on-split'] satisfies RekeyPolicy[]) {
    expect(ordered(facade.rekeyByLineage(['s'], [split], policy))).toEqual(ordered(oracle.rekeyByLineage(['s'], [split], policy)));
  }
});

wasmTest('conflicts observe every base before any head; aliases read relation and cardinality with original short circuits (#8042)', async () => {
  const facade = await adapter();
  const fixture = (): LineageEntry[] => [
    { base: ['z', 'a'], head: ['q'], relation: 'split', reason: '' },
    { base: ['z'], head: ['q'], relation: 'replaced', reason: '' },
    { base: ['a'], head: ['q'], relation: 'identity', reason: '' },
    { base: ['b'], head: ['h'], relation: 'identity', reason: '' },
    { base: ['b'], head: ['h'], relation: 'identity', reason: '' },
    { base: ['h'], head: ['h'], relation: 'identity', reason: '' },
  ];
  for (const operation of ['lineageConflicts', 'keyAliasesFromLineage'] as const) {
    const a: string[] = [], b: string[] = [];
    expect([...facade[operation](observed(fixture(), a))]).toEqual([...oracle[operation](observed(fixture(), b))]);
    expect(a).toEqual(b);
  }
  function changing(): LineageEntry[] {
    let relation = 0;
    return [{ base: ['b'], head: ['h'], get relation() { return ++relation === 1 ? 'split' : 'replaced'; }, reason: '' }];
  }
  const a: string[] = [], b: string[] = [];
  expect([...facade.keyAliasesFromLineage(observed(changing(), a))]).toEqual([...oracle.keyAliasesFromLineage(observed(changing(), b))]);
  expect(a).toEqual(b);
});

wasmTest('rekey indexes first wins before consuming one-shot keys and reads selected policy fields live (#8042)', async () => {
  const facade = await adapter();
  function fixture(): Lineage {
    return { entries: [
      { base: ['s'], head: ['x', 'y'], relation: 'split', reason: '', shares: [0.2, 0.8] },
      { base: ['s', 'b'], head: ['h'], relation: 'merge', reason: '' },
      { base: ['ignored'], get head(): string[] { throw new Error('unselected head'); },
        get relation(): 'identity' { throw new Error('unselected relation'); }, reason: '' },
    ], deleted: ['gone', 's'] };
  }
  function* keys(log: string[]) {
    log.push('keys:start');
    yield 'b'; yield 's'; yield 's'; yield 'gone'; yield 'other';
    log.push('keys:end');
  }
  for (const policy of policies) {
    const a: string[] = [], b: string[] = [];
    const actual = facade.rekeyByLineage(keys(a), observed(fixture(), a), policy);
    const expected = oracle.rekeyByLineage(keys(b), observed(fixture(), b), policy);
    expect(ordered(actual)).toEqual(ordered(expected));
    expect(a).toEqual(b);
    expect(Object.keys(actual[0])).toEqual(['key', 'successors', 'relation', 'orphan']);
    expect(Object.keys(actual[3])).toEqual(['key', 'successors', 'orphan']);
  }
});

wasmTest('largest-share follows accepted invalid-share guards, sparse observations and changing getters (#8042, #8084, #8131)', async () => {
  const facade = await adapter();
  // #8131 supersedes R124's invalid-share outcomes and adds .every observations.
  // Keep the same sparse and changing-getter inputs against the corrected TS expression.
  const sharesCases = [[NaN, 0.8], [Infinity, 1], [-1, -2], [0.5, 0.5], [], [0.8], [0.2, 0.8], Array<number>(2)];
  for (const shares of sharesCases) {
    for (const policy of policies) {
      const entry: LineageEntry = { base: ['s'], head: ['x', 'y'], relation: 'split', reason: '', shares };
      const a: string[] = [], b: string[] = [];
      expect(ordered(facade.rekeyByLineage(['s'], observed([entry], a), policy)))
        .toEqual(ordered(oracle.rekeyByLineage(['s'], observed([entry], b), policy)));
      expect(a).toEqual(b);
    }
  }
  function changing(): LineageEntry[] {
    let reads = 0;
    return [{ base: ['s'], head: ['x', 'y'], relation: 'split', reason: '',
      get shares() { reads++; return reads % 2 ? [0.1, 0.9] : [0.9, 0.1]; } }];
  }
  const a: string[] = [], b: string[] = [];
  expect(ordered(facade.rekeyByLineage(['s'], observed(changing(), a), 'largest-share')))
    .toEqual(ordered(oracle.rekeyByLineage(['s'], observed(changing(), b), 'largest-share')));
  expect(a).toEqual(b);
});

wasmTest('throwing selected getters preserve exception identity and close enclosing iterators (#8042)', async () => {
  const facade = await adapter();
  const sentinel = new RangeError('selected getter \ud800');
  for (const operation of ['lineageConflicts', 'keyAliasesFromLineage', 'rekeyByLineage'] as const) {
    const run = (implementation: typeof facade | typeof oracle, log: string[]) => {
      function* entries(): Generator<LineageEntry> {
        try {
          yield { get base(): string[] { throw sentinel; }, head: ['h'], relation: 'identity', reason: '' };
        } finally { log.push('entries:closed'); }
      }
      const input = entries() as unknown as LineageEntry[];
      try {
        if (operation === 'rekeyByLineage') implementation[operation](['b'], { entries: input });
        else implementation[operation](input);
        expect.unreachable('must throw');
      } catch (error) { expect(error).toBe(sentinel); }
    };
    const a: string[] = [], b: string[] = [];
    run(facade, a); run(oracle, b); expect(a).toEqual(b); expect(a).toEqual(['entries:closed']);
  }
  function run(implementation: typeof facade | typeof oracle, log: string[]) {
    function* keys() { try { yield 's'; } finally { log.push('keys:closed'); } }
    const entry: LineageEntry = { base: ['s'], head: ['x', 'y'], relation: 'split', reason: '',
      get shares(): number[] { throw sentinel; } };
    try { implementation.rekeyByLineage(keys(), [entry], 'largest-share'); expect.unreachable('must throw'); }
    catch (error) { expect(error).toBe(sentinel); }
  }
  const a: string[] = [], b: string[] = [];
  run(facade, a); run(oracle, b); expect(a).toEqual(b); expect(a).toEqual(['keys:closed']);
});

wasmTest('nested base iterators close on a thrown key and custom share filters retain their callback (#8042)', async () => {
  const facade = await adapter();
  const sentinel = new Error('base iterator');
  function nested(log: string[]) {
    function* base() { try { yield 'b'; throw sentinel; } finally { log.push('base:closed'); } }
    function* entries() {
      try { yield { base: base(), head: ['h'], relation: 'identity', reason: '' }; }
      finally { log.push('entries:closed'); }
    }
    return entries() as unknown as LineageEntry[];
  }
  for (const operation of ['lineageConflicts', 'rekeyByLineage'] as const) {
    const logs: string[][] = [];
    for (const implementation of [facade, oracle]) {
      const log: string[] = []; logs.push(log);
      try {
        if (operation === 'lineageConflicts') implementation[operation](nested(log));
        else implementation[operation](['b'], { entries: nested(log) });
        expect.unreachable('must throw');
      } catch (error) { expect(error).toBe(sentinel); }
    }
    expect(logs[0]).toEqual(logs[1]);
    expect(logs[0]).toEqual(['base:closed', 'entries:closed']);
  }
  function custom() {
    let retained: ((share: number) => boolean) | undefined;
    const shares = [0.1, 0.9];
    Object.defineProperty(shares, 'filter', { value: (callback: (share: number) => boolean) => {
      retained = callback;
      return [shares[1]];
    } });
    const entry: LineageEntry = { base: ['s'], head: ['x', 'y'], relation: 'split', reason: '', shares };
    return { entry, later: () => retained?.(0.9) };
  }
  const actual = custom(), expected = custom();
  expect(ordered(facade.rekeyByLineage(['s'], [actual.entry], 'largest-share')))
    .toEqual(ordered(oracle.rekeyByLineage(['s'], [expected.entry], 'largest-share')));
  expect(actual.later()).toBe(expected.later());
});
