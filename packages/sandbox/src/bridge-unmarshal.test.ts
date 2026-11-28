/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

function stubSdk(): { sdk: BimContext; received: unknown[] } {
  const received: unknown[] = [];
  const sdk = {
    export: { csv: (refs: unknown, options: unknown) => { received.push([refs, options]); return ''; } },
  } as unknown as BimContext;
  return { sdk, received };
}

describe('bounded sandbox decoding (#11600)', () => {
  it('reads a property once at each boundary and preserves ordinary values', async () => {
    const { sdk, received } = stubSdk();
    const sandbox = await createSandbox(sdk, { limits: { maxDumpDepth: 3 } });
    try {
      const result = await sandbox.eval(`
        let reads = 0;
        const options = { get columns() { reads++; return ['Name']; } };
        const entity = { get expressId() { reads++; return 7; }, modelId: 'm' };
        bim.export.csv([entity], options);
        console.log(options);
        ({ toJSON() { reads++; return { reads, options }; } });
      `, { typescript: false });
      expect(received).toEqual([[[{ modelId: 'm', expressId: 7 }], { columns: ['Name'] }]]);
      expect(result.logs[0]?.args).toEqual([{ columns: ['Name'] }]);
      expect(result.value).toEqual({ reads: 4, options: { columns: ['Name'] } });
      expect((await sandbox.eval('reads', { typescript: false })).value).toBe(5);
    } finally {
      sandbox.dispose();
    }
  });

  it.each([
    ['argument', 'bim.export.csv([], value)'],
    ['entity refs', 'bim.export.csv([value])'],
    ['console', 'console.log(value)'],
    ['result', 'value'],
    ['fulfilled result', 'Promise.resolve(value)'],
    ['toJSON result', '({ toJSON() { return value; } })'],
  ])('refuses a small value past the configured limit at the %s boundary', async (_boundary, expression) => {
    const { sdk, received } = stubSdk();
    const sandbox = await createSandbox(sdk, { limits: { maxDumpDepth: 2 } });
    try {
      await expect(sandbox.eval(`const value = { a: { b: { c: 1 } } }; ${expression};`, {
        typescript: false,
      })).rejects.toThrow(/depth limit 2/);
      expect(received).toEqual([]);
      expect((await sandbox.eval('({ a: { b: 1 } })', { typescript: false })).value)
        .toEqual({ a: { b: 1 } });
    } finally {
      sandbox.dispose();
    }
  });

  it('uses the same depth budget for shared objects and captured intrinsics', async () => {
    const { sdk } = stubSdk();
    const sandbox = await createSandbox(sdk, { limits: { maxDumpDepth: 2 } });
    try {
      const result = await sandbox.eval(`
        const shared = { name: 'wall' };
        JSON.stringify = () => '"changed"';
        ({ first: shared, second: shared });
      `, { typescript: false });
      expect(result.value).toEqual({ first: { name: 'wall' }, second: { name: 'wall' } });
      await expect(sandbox.eval('({ first: shared, nested: { second: shared } })', {
        typescript: false,
      })).rejects.toThrow(/depth limit 2/);
    } finally {
      sandbox.dispose();
    }
  });

  it('retains standard Error diagnostics with ordinary console arguments', async () => {
    const { sdk } = stubSdk();
    const sandbox = await createSandbox(sdk, { limits: { maxDumpDepth: 1 } });
    try {
      const result = await sandbox.eval(
        'console.error(Object.assign(new TypeError("example"), { detail: 7 }));',
        { typescript: false },
      );
      expect(result.logs[0]?.args).toEqual([{
        name: 'TypeError', message: 'example', stack: expect.any(String), detail: 7,
      }]);
    } finally {
      sandbox.dispose();
    }
  });

  it.each(['throw reason', 'Promise.reject(reason)'])('reads a thrown message once via %s', async (expression) => {
    const { sdk } = stubSdk();
    const sandbox = await createSandbox(sdk, { limits: { maxDumpDepth: 1 } });
    try {
      await expect(sandbox.eval(`
        let reads = 0;
        const reason = { get message() { reads++; return 'example'; } };
        ${expression};
      `, { typescript: false })).rejects.toThrow('example');
      expect((await sandbox.eval('reads', { typescript: false })).value).toBe(1);
    } finally {
      sandbox.dispose();
    }
  });
});
