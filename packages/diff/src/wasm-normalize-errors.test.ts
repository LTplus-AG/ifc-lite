/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import * as oracle from '../test/oracle/fingerprint.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);

// #8110 review r4389124798: the oracle catches arbitrary traversal throws,
// including runtime-error instances. Error class cannot identify provenance.
test.skipIf(!existsSync(binary) || !existsSync(glue))('normalization preserves arbitrary serialization throws and fallback failures (#8110)', async () => {
  const facade = await import('./wasm-fingerprint.js');
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const raised of [new WebAssembly.RuntimeError('host runtime error'), new Error('host error'),
      Symbol('host sentinel'), 37, null, undefined]) {
      const observe = (normalize: typeof oracle.normalizeValue) => {
        const trace: string[] = [];
        const input = { get value(): never { trace.push('value'); throw raised; },
          toString() { trace.push('fallback'); return 'fallback'; } };
        const output = normalize(input);
        expect(warn.mock.calls.at(-1)?.[1]).toBe(raised);
        return { output, trace };
      };
      expect(observe(facade.normalizeValue)).toEqual(observe(oracle.normalizeValue));
      for (const normalize of [facade.normalizeValue, oracle.normalizeValue]) {
        const fallback = Symbol('fallback coercion failure');
        const input = { get value(): never { throw raised; },
          [Symbol.toPrimitive](): never { throw fallback; } };
        let caught: unknown;
        try { normalize(input); } catch (error) { caught = error; }
        expect(caught).toBe(fallback);
        expect(warn.mock.calls.at(-1)?.[1]).toBe(raised);
      }
    }
  } finally { warn.mockRestore(); }
});
