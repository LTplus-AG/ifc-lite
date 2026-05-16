/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createMemorySandboxFactory } from './memory-factory.js';
import { wrapEntrySource } from './source-wrap.js';

async function createHandle() {
  const factory = createMemorySandboxFactory();
  return factory.create({
    extensionId: 'ext-test',
    permissions: {},
  });
}

describe('createMemorySandboxFactory — basic eval', () => {
  it('runs a trivial IIFE expression', async () => {
    // The factory only accepts the IIFE-expression shape produced by
    // `wrapEntrySource`. We feed a hand-written IIFE here to exercise
    // the run plumbing directly.
    const handle = await createHandle();
    const r = await handle.run('(() => 1 + 2)()');
    expect(r.value).toBe(3);
  });

  it('returns the IIFE result for wrapped sources', async () => {
    const handle = await createHandle();
    const wrap = wrapEntrySource(
      'function activate(ctx) { return ctx.bim.x; }',
      { entryFnName: 'activate' },
    );
    if (!wrap.ok) throw new Error('wrap failed');

    await handle.setGlobal('__ifclite_ctx__', { bim: { x: 42 } });
    const r = await handle.run(wrap.value);
    expect(r.value).toBe(42);
  });

  it('captures console logs', async () => {
    const handle = await createHandle();
    const wrap = wrapEntrySource(
      'function activate(ctx) { console.log("hi"); console.warn("oops"); }',
      { entryFnName: 'activate' },
    );
    if (!wrap.ok) throw new Error('wrap failed');

    await handle.setGlobal('__ifclite_ctx__', { bim: null });
    const r = await handle.run(wrap.value);
    expect(r.logs).toHaveLength(2);
    expect(r.logs[0].level).toBe('log');
    expect(r.logs[0].message).toBe('hi');
    expect(r.logs[1].level).toBe('warn');
  });

  it('records duration', async () => {
    const handle = await createHandle();
    const wrap = wrapEntrySource(
      'function activate(ctx) { return 1; }',
      { entryFnName: 'activate' },
    );
    if (!wrap.ok) throw new Error('wrap failed');
    await handle.setGlobal('__ifclite_ctx__', { bim: null });
    const r = await handle.run(wrap.value);
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('propagates thrown errors', async () => {
    const handle = await createHandle();
    const wrap = wrapEntrySource(
      'function activate() { throw new Error("boom"); }',
      { entryFnName: 'activate' },
    );
    if (!wrap.ok) throw new Error('wrap failed');
    await handle.setGlobal('__ifclite_ctx__', { bim: null });
    await expect(handle.run(wrap.value)).rejects.toThrow('boom');
  });
});

describe('createMemorySandboxFactory — disposal', () => {
  it('throws after dispose', async () => {
    const handle = await createHandle();
    await handle.dispose();
    await expect(handle.run('return 1;')).rejects.toThrow('disposed');
  });

  it('setGlobal throws after dispose', async () => {
    const handle = await createHandle();
    await handle.dispose();
    expect(() => handle.setGlobal('x', 1)).toThrow('disposed');
  });

  it('dispose is idempotent', async () => {
    const handle = await createHandle();
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
  });
});

describe('createMemorySandboxFactory — globals', () => {
  it('setGlobal makes values available in subsequent run', async () => {
    const handle = await createHandle();
    await handle.setGlobal('__ifclite_ctx__', { bim: { tag: 'first' } });
    const wrap = wrapEntrySource(
      'function activate(ctx) { return ctx.bim.tag; }',
      { entryFnName: 'activate' },
    );
    if (!wrap.ok) throw new Error('wrap failed');
    const r = await handle.run(wrap.value);
    expect(r.value).toBe('first');
  });

  it('setGlobal replaces previous value', async () => {
    const handle = await createHandle();
    await handle.setGlobal('__ifclite_ctx__', { bim: { tag: 'first' } });
    await handle.setGlobal('__ifclite_ctx__', { bim: { tag: 'second' } });
    const wrap = wrapEntrySource(
      'function activate(ctx) { return ctx.bim.tag; }',
      { entryFnName: 'activate' },
    );
    if (!wrap.ok) throw new Error('wrap failed');
    const r = await handle.run(wrap.value);
    expect(r.value).toBe('second');
  });
});
