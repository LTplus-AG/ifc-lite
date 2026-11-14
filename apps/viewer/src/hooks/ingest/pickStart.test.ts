/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pick hook: the single place a load may start work before its reset.
 * Starters run synchronously, in order; nothing is awaited.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PickStartContext } from './pickStart.js';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const modulePath = './pickStart.js';
const mod: typeof import('./pickStart.js') | null = await import(modulePath).catch(() => null);
function hook() {
  assert.ok(mod, 'the pick hook exists (hooks/ingest/pickStart.ts)');
  return mod;
}

const ctx = (): PickStartContext => ({
  file: new File(['ISO-10303-21;'], 'a.ifc'),
  target: { kind: 'primary' },
  kernel: { kind: 'exact' } as PickStartContext['kernel'],
  retry: false,
  isCurrent: () => true,
});

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('runPickStart', () => {
  it('runs starters in order, synchronously, and returns nothing to await', () => {
    const order: string[] = [];
    cleanups.push(hook().registerPickStarter(() => order.push('a')), hook().registerPickStarter(() => order.push('b')));
    const out = hook().runPickStart(ctx()) as unknown;
    assert.equal(out, undefined, 'the load must not await');
    assert.deepEqual(order, ['a', 'b']);
  });

  it('a throwing starter does not stop the others', () => {
    const seen: string[] = [];
    cleanups.push(hook().registerPickStarter(() => { throw new Error('boom'); }));
    cleanups.push(hook().registerPickStarter(() => seen.push('second')));
    hook().runPickStart(ctx());
    assert.deepEqual(seen, ['second']);
  });

  it('an unregistered starter no longer runs', () => {
    let runs = 0;
    const off = hook().registerPickStarter(() => { runs++; });
    hook().runPickStart(ctx());
    off();
    hook().runPickStart(ctx());
    assert.equal(runs, 1);
  });
});
