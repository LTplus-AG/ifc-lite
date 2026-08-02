/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for the `JS_FreeRuntime` abort (#1905):
 *
 *   Aborted(Assertion failed: list_empty(&rt->gc_obj_list),
 *           at: ../../vendor/quickjs/quickjs.c,2036, JS_FreeRuntime)
 *
 * A handle created through a QuickJSContext is an *unmanaged* Lifetime —
 * `context.dispose()` does not free it. So any handle the bridge creates and
 * fails to dispose keeps a JSObject on the runtime's GC list, and
 * `runtime.dispose()` trips that assertion: an emscripten `abort()` that kills
 * the WASM module for the rest of the document lifetime.
 *
 * The assertion is therefore the leak oracle these tests use — "dispose() does
 * not throw" is precisely "no live handles remain". Each case drives the real
 * `createSandbox` -> real bridge -> real `dispose()` path.
 *
 * This file is kept separate so vitest gives it its own worker: an abort
 * poisons the shared WASM module for every later test in the same process.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

const CREATE_ONLY_PERMISSIONS = {
  query: false,
  mutate: false,
  viewer: false,
  export: true,
  model: false,
  lens: false,
  files: false,
} as const;

/**
 * Minimal SDK stub whose `bim.model.list()` hands the bridge `value`.
 * `model.list` is a `returns: 'value'` method, so the value goes straight
 * through `marshalValue` — the recursive marshaller under test.
 */
function sdkReturning(value: () => unknown): BimContext {
  return { model: { list: value } } as unknown as BimContext;
}

/**
 * Run `script`, expect it to fail (the marshaller throws host-side), then
 * assert teardown is clean. The abort surfaces from `dispose()`, not `eval()`.
 */
async function evalThenDispose(sdk: BimContext, script: string): Promise<void> {
  const sandbox = await createSandbox(sdk);
  try {
    await expect(sandbox.eval(script, { typescript: false })).rejects.toThrow();
  } finally {
    expect(() => sandbox.dispose()).not.toThrow();
  }
}

describe('sandbox dispose after a failed marshal (#1905)', () => {
  it('frees the half-built object when an own getter throws mid-marshal', async () => {
    const sdk = sdkReturning(() => [
      { id: 'a' },
      {
        id: 'b',
        get name(): string {
          throw new Error('property read exploded');
        },
      },
    ]);

    await evalThenDispose(sdk, 'bim.model.list()');
  });

  it('frees the half-built array when an element cannot be inspected', async () => {
    const { proxy, revoke } = Proxy.revocable({ id: 'a' }, {});
    revoke(); // every operation on `proxy` — including Array.isArray — now throws
    const sdk = sdkReturning(() => [{ id: 'ok' }, proxy]);

    await evalThenDispose(sdk, 'bim.model.list()');
  });

  it('frees every container in the recursion, not just the innermost', async () => {
    const sdk = sdkReturning(() => [
      {
        id: 'a',
        rows: [
          { ok: true },
          {
            get value(): number {
              throw new Error('nested read exploded');
            },
          },
        ],
      },
    ]);

    await evalThenDispose(sdk, 'bim.model.list()');
  });

  it('still reports the host error to the script', async () => {
    const sdk = sdkReturning(() => [
      {
        get name(): string {
          throw new Error('property read exploded');
        },
      },
    ]);

    const sandbox = await createSandbox(sdk);
    try {
      await expect(sandbox.eval('bim.model.list()', { typescript: false })).rejects.toThrow(
        'bim.model.list: property read exploded',
      );
    } finally {
      expect(() => sandbox.dispose()).not.toThrow();
    }
  });

  it.each([
    ['a script that throws', 'throw new Error("script blew up")'],
    ['an async body drained from the job queue', '(async () => { return 41 + 1; })(), 42'],
    ['a promise left pending at exit', 'new Promise(() => {}), "done"'],
  ])('disposes cleanly after %s', async (_label, script) => {
    // Guards the eval() result-handle ownership: whichever exit eval() takes,
    // the handle from evalCode() must be freed before teardown.
    const sandbox = await createSandbox({} as BimContext);
    try {
      await sandbox.eval(script, { typescript: false }).catch(() => undefined);
    } finally {
      expect(() => sandbox.dispose()).not.toThrow();
    }
  });

  it('disposes cleanly after a successful create run (no over-disposal)', async () => {
    const sandbox = await createSandbox({} as BimContext, {
      permissions: CREATE_ONLY_PERMISSIONS,
    });

    try {
      const result = await sandbox.eval(
        `const h = bim.create.project({ Name: "Leak Check" });
         const storey = bim.create.addIfcBuildingStorey(h, { Name: "GF", Elevation: 0 });
         bim.create.addIfcWall(h, storey, {
           Name: "Wall", Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
         });
         bim.create.toIfc(h).content.length;`,
        { typescript: false },
      );
      expect(result.value).toBeGreaterThan(0);
    } finally {
      expect(() => sandbox.dispose()).not.toThrow();
    }
  });
});
