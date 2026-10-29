/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as identityOracle from '../test/oracle/identity-sidecar.js';
import * as lineageOracle from '../test/oracle/lineage-sidecar.js';
import type { IdentityMapSidecarInit } from './identity-sidecar.js';
import type { LineageSidecarInit } from './lineage-sidecar.js';
import type { LineageEntry } from './lineage.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
const models = { base: { hash: 'old' }, head: { hash: 'new' } };

test('public structural signature captures JSON.stringify before member getters (#8042, #8130)', async (context) => {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
    return;
  }
  const api = await import('./index.js');
  api.initDiffSync({ module: readFileSync(binary) });
  function run(create: typeof identityOracle.createIdentityMapSidecar) {
    const log: string[] = [];
    const original = JSON.stringify;
    const late = new Error('late stringify lookup');
    try {
      // A late lookup in a host adapter calls the replacement and throws.
      JSON.stringify = ((...args: Parameters<typeof original>) => {
        log.push('captured stringify');
        return original(...args);
      }) as typeof original;
      const input: IdentityMapSidecarInit = { ...models, entries: [{
        get base() {
          log.push('base');
          JSON.stringify = () => { throw late; };
          return 'b';
        },
        get here() { log.push('here'); return 'h'; }, reason: 'first',
      }] };
      return { value: create(input), log };
    } finally { JSON.stringify = original; }
  }
  const expected = run(identityOracle.createIdentityMapSidecar);
  expect(run(api.createIdentityMapSidecar)).toEqual(expected);
  expect(expected.log.slice(0, 3)).toEqual(['base', 'here', 'captured stringify']);
});

test('public structural signatures observe toJSON and close iterators on its original thrown value (#8042, #8130)', async (context) => {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
    return;
  }
  const api = await import('./index.js');
  api.initDiffSync({ module: readFileSync(binary) });
  const sentinel = new RangeError('signature toJSON \ud800');
  for (const create of [lineageOracle.createLineageSidecar, api.createLineageSidecar]) {
    const log: string[] = [];
    const base = ['b'];
    Object.defineProperty(base, 'join', { value() { throw new Error('obsolete join'); } });
    Object.defineProperty(base, 'toJSON', { value(key: string) { log.push(`toJSON:${key}`); throw sentinel; } });
    // This iterator closes over the current API call's sentinel and observation log (#8042).
    // eslint-disable-next-line no-inner-declarations
    function* entries(): Generator<LineageEntry> {
      try {
        yield { get relation(): LineageEntry['relation'] { log.push('relation'); return 'identity'; },
          get base() { log.push('base'); return base; },
          get head() { log.push('head'); return ['h']; }, reason: '' };
      } finally { log.push('closed'); }
    }
    const input = { ...models, entries: entries() } as unknown as LineageSidecarInit;
    try { create(input); expect.unreachable('toJSON must throw'); }
    catch (error) { expect(error).toBe(sentinel); }
    expect(log).toEqual(['relation', 'base', 'head', 'toJSON:1', 'closed']);
  }
});

test('public signature reports JSON TypeError and skips duplicate provenance reads (#8042, #8130)', async (context) => {
  if (!existsSync(binary) || !existsSync(glue)) {
    context.skip('Optional diff WASM glue/binary missing; run pnpm build:wasm, then root pnpm test --filter=@ifc-lite/diff');
    return;
  }
  const api = await import('./index.js');
  api.initDiffSync({ module: readFileSync(binary) });
  for (const create of [identityOracle.createIdentityMapSidecar, api.createIdentityMapSidecar]) {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const malformed = { ...models, entries: [{ base: cyclic, here: 'h', reason: '' }] } as unknown as IdentityMapSidecarInit;
    expect(() => create(malformed)).toThrow(TypeError);
    const input = { ...models, entries: [
      { base: '\ud800', here: 'h', reason: 'first' },
      { base: '\ud800', here: 'h', get reason(): string { throw new Error('duplicate provenance'); } },
    ] };
    expect(create(input).entries).toEqual([{ base: '\ud800', here: 'h', reason: 'first' }]);
  }
});
