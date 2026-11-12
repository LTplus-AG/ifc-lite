/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pick hook: the single place a load may start work before its reset.
 * Starters run synchronously first, then at most one yield, awaited for at
 * most the cap; with no yield the load does not await at all.
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
const registerPickStarter: typeof import('./pickStart.js')['registerPickStarter'] = (...a) => hook().registerPickStarter(...a);
const registerPickYield: typeof import('./pickStart.js')['registerPickYield'] = (...a) => hook().registerPickYield(...a);
const runPickStart: typeof import('./pickStart.js')['runPickStart'] = (...a) => hook().runPickStart(...a);

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
  it('runs starters in order, synchronously, before the yield, and returns nothing to await without a yield', () => {
    const order: string[] = [];
    cleanups.push(registerPickStarter(() => order.push('a')), registerPickStarter(() => order.push('b')));
    const out = runPickStart(ctx());
    assert.equal(out, undefined, 'no yield registered: the load must not await');
    assert.deepEqual(order, ['a', 'b']);
  });

  it('calls the yield after every starter and settles when the yield settles', async () => {
    const order: string[] = [];
    let release!: () => void;
    cleanups.push(registerPickStarter(() => order.push('starter')));
    cleanups.push(registerPickYield(() => { order.push('yield'); return new Promise<void>((r) => { release = r; }); }));
    const out = runPickStart(ctx(), 10_000);
    assert.deepEqual(order, ['starter', 'yield']);
    assert.ok(out instanceof Promise);
    let settled = false;
    void out!.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting on the yield');
    release();
    await out;
    assert.equal(settled, true);
  });

  it('caps a yield that never settles', async () => {
    cleanups.push(registerPickYield(() => new Promise(() => {})));
    const t0 = performance.now();
    await runPickStart(ctx(), 30);
    const waited = performance.now() - t0;
    assert.ok(waited >= 25 && waited < 1000, `waited ${waited.toFixed(1)} ms for a 30 ms cap`);
  });

  it('never rejects, and a throwing starter does not stop the others or the yield', async () => {
    const seen: string[] = [];
    cleanups.push(registerPickStarter(() => { throw new Error('boom'); }));
    cleanups.push(registerPickStarter(() => seen.push('second')));
    cleanups.push(registerPickYield(() => { seen.push('yield'); return Promise.reject(new Error('no device')); }));
    await runPickStart(ctx(), 1000);
    assert.deepEqual(seen, ['second', 'yield']);
  });

  it('accepts one yield at a time and frees the slot when it unregisters', () => {
    const off = registerPickYield(() => undefined);
    assert.throws(() => registerPickYield(() => undefined), /already registered/);
    off();
    cleanups.push(registerPickYield(() => undefined));
  });

  it('an unregistered starter no longer runs', () => {
    let runs = 0;
    const off = registerPickStarter(() => { runs++; });
    runPickStart(ctx());
    off();
    runPickStart(ctx());
    assert.equal(runs, 1);
  });
});
