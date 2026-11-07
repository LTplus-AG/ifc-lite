/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import * as oracle from '../test/oracle/fingerprint.js';

const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
test.skipIf(!existsSync(binary) || !existsSync(glue))('Rust normalizes host values and hashes every UTF-16 unit (#8042)', async () => {
  const facade = await import('./wasm-fingerprint.js');
  const { initDiffSync } = await import('./wasm-runtime.js');
  expect(() => facade.normalizeValue(null)).toThrow(/initDiff/);
  initDiffSync({ module: readFileSync(binary) });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const arrayCycle: unknown[] = []; arrayCycle.push(arrayCycle);
    const shared = { z: 1, a: 'x' };
    const values: unknown[] = [undefined, null, false, true, -0, 1 / 3, NaN, Infinity, -Infinity,
      '\ud800', '😀', '\udfff', '\\ud800', Symbol('x'), () => 1, 12n,
      new Array(2), [undefined, () => 1, Symbol('x')], new Date(0), Object(3),
      { z: undefined, a: Symbol('x'), f: () => 1 }, { a: shared, b: shared }, cycle, arrayCycle,
      { get bad(): never { throw new Error('getter'); } }, { toJSON: () => 'ignored on composites', value: 1 },
      { '\ue000': 1, '𐀀': 2, '\ud800': 3 },
    ];
    for (const value of values) expect(facade.normalizeValue(value)).toEqual(oracle.normalizeValue(value));
    const terminating = () => {
      let reads = 0;
      const value: { readonly x: unknown } = { get x() { return reads++ === 0 ? value : 0; } };
      return value;
    };
    expect(facade.normalizeValue(terminating())).toBe(oracle.normalizeValue(terminating()));
    for (const field of ['materials', 'classifications'] as const) {
      const input = { ifcType: 'IfcWall', [field]: new Array<string>(2) };
      expect(facade.buildDataFingerprint(input)).toBe(oracle.buildDataFingerprint(input));
      expect(Object.entries(facade.buildComponentFingerprints(input))).toEqual(Object.entries(oracle.buildComponentFingerprints(input)));
    }
    const observed = (normalize: typeof oracle.normalizeValue) => {
      const order: string[] = [];
      const input = { get z() { order.push('z'); return 1; }, get a() { order.push('a'); return 2; } };
      return { output: normalize(input), order };
    };
    expect(observed(facade.normalizeValue)).toEqual(observed(oracle.normalizeValue));
    for (const value of ['', 'a', '\ud800', '\udfff', '😀', '\ue000', 'a\ud800b']) {
      expect(facade.stableHash(value)).toBe(oracle.stableHash(value));
    }
    const uncoercible = { self: null as unknown, [Symbol.toPrimitive](): never { throw new Error('cannot convert'); } };
    uncoercible.self = uncoercible;
    expect(() => facade.normalizeValue(uncoercible)).toThrow('cannot convert');
    expect(() => oracle.normalizeValue(uncoercible)).toThrow('cannot convert');
  } finally { warn.mockRestore(); }
});

// Exercise actual wasm callbacks: a TS replacement cannot prove their lifetime,
// exception identity, or UTF-16 transport across the Rust boundary (#8042 P2).
test.skipIf(!existsSync(binary) || !existsSync(glue))('Rust preserves observable array map/join behavior (#8042 P2)', async () => {
  const facade = await import('./wasm-fingerprint.js');
  const { initDiffSync } = await import('./wasm-runtime.js');
  initDiffSync({ module: readFileSync(binary) });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  type Normalize = typeof oracle.normalizeValue;
  type Callback = (value: unknown) => string;
  const compare = (observe: (normalize: Normalize) => unknown) => {
    expect(observe(facade.normalizeValue)).toEqual(observe(oracle.normalizeValue));
  };
  try {
    for (const method of ['map', 'join']) {
      compare((normalize) => {
        const sentinel = { method };
        const input = [1];
        if (method === 'map') {
          Object.defineProperty(input, 'map', { get() { throw sentinel; } });
        } else {
          Object.defineProperty(input, 'map', { value: () => ({ get join(): never { throw sentinel; } }) });
        }
        const output = normalize(input);
        expect(output).toBe('1');
        expect(warn.mock.calls.at(-1)).toEqual([
          '[diff] normalizeValue: non-serializable value, using String() fallback:', sentinel,
        ]);
        return output;
      });
    }
    compare((normalize) => {
      const sentinel = { failure: 'native map callback' };
      const input = [{ get a(): never { throw sentinel; } }];
      const output = normalize(input);
      expect(output).toBe('[object Object]');
      expect(warn.mock.calls.at(-1)?.[1]).toBe(sentinel);
      return output;
    });
    compare((normalize) => {
      const order: string[] = [];
      const input = [1];
      Object.defineProperty(input, 'map', { get() {
        order.push('map getter');
        return function (this: unknown, callback: Callback) {
          expect(this).toBe(input);
          order.push(callback({ z: 1, a: 2 }));
          const mapped = { get join() {
            order.push('join getter');
            return function (this: unknown, separator: string) {
              expect(this).toBe(mapped);
              order.push(separator);
              return { [Symbol.toPrimitive](hint: string) { order.push(hint); return '\ud800x\udfff'; } };
            };
          } };
          return mapped;
        };
      } });
      return { output: normalize({ array: input }), order };
    });
    compare((normalize) => {
      const order: string[] = [];
      const input = new Array<unknown>(3);
      input[2] = { z: 1, a: 2 };
      const prototype = Object.create(Array.prototype) as object;
      Object.defineProperty(prototype, '1', { get() { order.push('inherited slot'); return undefined; } });
      Object.setPrototypeOf(input, prototype);
      Object.defineProperty(input, 'constructor', { get() {
        order.push('constructor');
        return { get [Symbol.species]() {
          order.push('species');
          return function (length: number) {
            order.push(`allocate:${length}`);
            return { join(separator: string) {
              order.push(`join:${separator}`);
              return `species:${Reflect.get(this, '1')}:${Reflect.get(this, '2')}`;
            } };
          };
        } };
      } });
      return { output: normalize(input), order };
    });
    for (const fail of [false, true]) {
      compare((normalize) => {
        const retained: { callback?: Callback } = {};
        const sentinel = { failure: 'map' };
        const input = [1];
        Object.defineProperty(input, 'map', { configurable: true, value(callback: Callback) {
          retained.callback = callback;
          if (fail) throw sentinel;
          return ['first'];
        } });
        const first = normalize(input);
        if (!retained.callback) throw new Error('map did not receive a callback');
        Object.defineProperty(input, 'map', { value: () => ['later'] });
        // The parent array must no longer be in the retained callback's path,
        // including when the original map threw before returning.
        return { first, later: retained.callback(input), object: retained.callback({ b: 1, a: 2 }) };
      });
    }
    compare((normalize) => {
      const retained: { callback?: Callback } = {};
      const sentinel = { failure: 'callback getter' };
      const input = [1];
      const child = { get a(): unknown {
        if (!retained.callback) throw new Error('missing callback');
        return retained.callback({ z: 1, a: 2 });
      } };
      Object.defineProperty(input, 'map', { value(callback: Callback) {
        retained.callback = callback;
        const bad = {};
        Object.defineProperty(bad, 'a', { configurable: true, enumerable: true, get(): never { throw sentinel; } });
        let caught = false;
        try { callback(bad); } catch (error) { expect(error).toBe(sentinel); caught = true; }
        expect(caught).toBe(true);
        Object.defineProperty(bad, 'a', { value: 1 });
        expect(callback(bad)).toBe('{"a":1}');
        // Reenter the same immutable closure while its outer call is active.
        return [callback(child), callback(child)];
      } });
      const output = normalize(input);
      if (!retained.callback) throw new Error('map did not receive a callback');
      return { output, later: retained.callback(child) };
    });
    compare((normalize) => {
      const sentinel = { failure: 'String fallback' };
      const input = [1];
      Object.defineProperty(input, 'map', { get(): never { throw new Error('map'); } });
      Object.defineProperty(input, Symbol.toPrimitive, { value(): never { throw sentinel; } });
      try { normalize(input); } catch (error) { expect(error).toBe(sentinel); return 'same exception'; }
      throw new Error('fallback must throw');
    });
    compare((normalize) => {
      const input = [1];
      Object.defineProperty(input, 'map', { value: () => ({ join: () => Symbol('join') }) });
      warn.mockClear();
      const output = normalize(input);
      expect(output).toBe('1');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toBeInstanceOf(TypeError);
      return output;
    });
    compare((normalize) => {
      const order: string[] = [];
      const sentinel = { failure: 'first sorted getter' };
      const input = {
        get z(): never { order.push('z'); throw new Error('must not read z'); },
        get a(): never { order.push('a'); throw sentinel; },
      };
      warn.mockClear();
      const output = normalize(input);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toBe(sentinel);
      return { output, order };
    });
    compare((normalize) => normalize({ '2': 2, '10': 10, '\ud800': 3, '𐀀': 4, '\ue000': 5 }));
  } finally { warn.mockRestore(); }
});

// Keep the recursive TS oracle outside Vitest's transform/worker stack so its
// host stack limit does not masquerade as a Rust failure (#8042).
test.skipIf(!existsSync(binary) || !existsSync(glue))('Rust serializes deep finite graphs and recovers after cycles (#8042)', () => {
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL('../test/wasm-fingerprint-deep.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 });
  const diagnostic = JSON.stringify({
    error: child.error?.message, status: child.status, signal: child.signal,
    stdout: child.stdout, stderr: child.stderr,
  });
  expect(child.error, diagnostic).toBeUndefined();
  expect(child.signal, diagnostic).toBeNull();
  expect(child.status, diagnostic).toBe(0);
  expect(child.stderr, diagnostic).toBe('');
  const summary = JSON.parse(child.stdout);
  const finite = [512, 1024, 2048].flatMap(depth =>
    ['array', 'object', 'mixed'].map(kind => `finite:${depth}:${kind}`));
  expect(summary).toEqual({
    protocol: 'wasm-fingerprint-deep-v1',
    caseIds: [...finite, 'cycle:object', 'recovery:object:2048:mixed',
      'cycle:array', 'recovery:array:2048:mixed', 'retained:success:2048:mixed',
      'retained:throw:2048:mixed'],
    caseCount: 15, finiteCaseCount: 9, cycleCaseCount: 2,
    recoveryCaseCount: 2, retainedCaseCount: 2,
    finiteWarningCount: 0, recoveryWarningCount: 0, retainedCallbackWarningCount: 0,
    fallbackWarningCount: 6, normalizeCallCount: 30, retainedCallbackCount: 4,
  });
});
