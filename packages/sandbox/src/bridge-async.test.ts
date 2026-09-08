/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2305 — an async bridge method used to be undeliverable and unobservable.
 *
 * `bim.clash.run` returns a host Promise. The bridge marshalled it as an
 * ordinary object (no own enumerable properties, so the script got `{}`) and
 * the real work carried on unwatched: a failure inside it rejected with nobody
 * listening, which is how a `ClashElement` missing its `tag` reached production
 * as an uncaught `TypeError: Cannot read properties of undefined (reading
 * 'toUpperCase')` from `matchesSelector`, with `$exception_handled: false`.
 *
 * These run the real QuickJS realm and the real `ClashNamespace`, so they pin
 * the whole path the crash took, not a stand-in for it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClashNamespace, type BimContext } from '@ifc-lite/sdk';
import { NAMESPACE_SCHEMAS, type NamespaceSchema } from './bridge-schema.js';
import { buildClashNamespace } from './bridge-clash.js';
import { createSandbox, isSandboxRuntimeAborted, ScriptError, type Sandbox } from './sandbox.js';

/** A unit cube at `x`, meshed as 12 triangles — enough for the engine to run for real. */
function cube(key: string, x: number, tag?: string): Record<string, unknown> {
  const element: Record<string, unknown> = {
    key,
    ref: key === 'a' ? 1 : 2,
    model: 'm',
    bounds: { min: [x, 0, 0], max: [x + 1, 1, 1] },
    positions: [
      x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0,
      x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1,
    ],
    indices: [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 3, 7, 0, 7, 4,
    ],
  };
  // Deliberately omitted for the untagged case — the field whose absence
  // produced the #2305 TypeError.
  if (tag !== undefined) element.tag = tag;
  return element;
}

const RULES = [{ id: 'r1', name: 'wall x slab', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' }];

/**
 * Node reports an unhandled rejection on the process, which is where the
 * browser's uncaught-error handler (and PostHog) saw #2305. Capturing them is
 * the only way to assert the *uncaught* half of the bug.
 */
let unhandled: unknown[] = [];
const record = (err: unknown): void => { unhandled.push(err); };

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', record);
});

afterEach(() => {
  process.off('unhandledRejection', record);
});

/**
 * The exact production signature of #2305, isolated from any other unhandled
 * rejection the process may report: `matchesSelector` reading `toUpperCase` off
 * an undefined `tag`. Used by the boundary tests so they assert their own
 * property rather than the whole process's rejection history.
 */
function crashSignature(): string[] {
  return unhandled.map((err) => (err instanceof Error ? err.message : String(err)))
    .filter((message) => message.includes('toUpperCase'));
}

/** Give any orphaned rejection a turn to be reported before asserting there is none. */
async function flushRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function sdkWithClash(): BimContext {
  return { clash: new ClashNamespace() } as unknown as BimContext;
}

describe('#2305 — async bridge methods', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox(sdkWithClash());
  });

  afterEach(() => {
    sandbox.dispose();
  });

  it('delivers a real awaitable result instead of an empty object', async () => {
    const script = `
      const elements = ${JSON.stringify([cube('a', 0, 'IfcWall'), cube('b', 0.5, 'IfcSlab')])};
      (async () => {
        const result = await bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
        return { clashes: result.clashes.length, total: result.summary.total };
      })();
    `;
    const result = await sandbox.eval(script);
    // A main body that evaluates to a promise is dumped as `{ type, value }` —
    // pre-existing `vm.dump` behaviour, unrelated to this fix. What matters is
    // the payload: before the fix the script received `{}`, so `result.clashes`
    // was undefined and the script threw inside the sandbox.
    expect(result.value).toEqual({ type: 'fulfilled', value: { clashes: 1, total: 1 } });
    await flushRejections();
    expect(unhandled).toEqual([]);
  });

  it('reports a host rejection as a script error, not an unhandled rejection', async () => {
    // `matchesSelector` is reached only for elements that survive the bridge's
    // own validation, so the rejection is forced from the SDK side instead.
    const failing = {
      clash: { run: () => Promise.reject(new Error('engine exploded')) },
    } as unknown as BimContext;
    const isolated = await createSandbox(failing);
    try {
      const script = `
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
        (async () => { await bim.clash.run(elements, ${JSON.stringify(RULES)}, {}); })();
      `;
      await expect(isolated.eval(script)).rejects.toThrow(/bim\.clash\.run: engine exploded/);
      await flushRejections();
      expect(unhandled).toEqual([]);
    } finally {
      isolated.dispose();
    }
  });

  it('lets a script catch a host rejection on the same channel as a sync failure', async () => {
    const failing = {
      clash: { run: () => Promise.reject(new Error('engine exploded')) },
    } as unknown as BimContext;
    const isolated = await createSandbox(failing);
    try {
      const script = `
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
        (async () => {
          try {
            await bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
            return 'no error';
          } catch (err) {
            return err.message;
          }
        })();
      `;
      const result = await isolated.eval(script);
      expect(result.value).toEqual({ type: 'fulfilled', value: 'bim.clash.run: engine exploded' });
      await flushRejections();
      expect(unhandled).toEqual([]);
    } finally {
      isolated.dispose();
    }
  });
});

/** An SDK whose only clash method never settles — the stalled-host-work case. */
function stalledSdk(): BimContext {
  return { clash: { run: () => new Promise(() => { /* never settles */ }) } } as unknown as BimContext;
}

const STALL_SCRIPT = `
  const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
  (async () => { await bim.clash.run(elements, ${JSON.stringify(RULES)}, {}); })();
`;

describe('#2305 — a host promise cannot hang the run', () => {
  it('times out a never-settling host promise at its own deadline', async () => {
    // The QuickJS interrupt handler only fires while *guest* code runs, so it
    // cannot see a host promise that never settles. The drain carries its own
    // deadline; without one this eval would never return.
    const isolated = await createSandbox(stalledSdk(), { limits: { timeoutMs: 300 } });
    try {
      const error = await isolated.eval(STALL_SCRIPT).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ScriptError);
      expect((error as ScriptError).message).toBe('interrupted');
      // Bounded by the run's *own* budget, not by the test runner giving up:
      // a drain without a deadline would only ever fail at vitest's timeout.
      const durationMs = (error as ScriptError).durationMs;
      expect(durationMs).toBeGreaterThanOrEqual(250);
      expect(durationMs).toBeLessThan(1_500);
    } finally {
      // Teardown with a deferred still outstanding must not abort the module.
      expect(() => isolated.dispose()).not.toThrow();
    }
  });

  it('does not make later runs on the same sandbox inherit the stalled wait', async () => {
    // The queue is sandbox-scoped, and the extension host keeps one sandbox
    // alive across many evals — so a run that gave up waiting must drop the
    // in-flight entry, or every later run burns the whole budget and fails
    // with `interrupted` forever.
    const isolated = await createSandbox(stalledSdk(), { limits: { timeoutMs: 300 } });
    try {
      await expect(isolated.eval(STALL_SCRIPT)).rejects.toThrow('interrupted');
      const started = Date.now();
      const result = await isolated.eval('1 + 1');
      expect(result.value).toBe(2);
      // A pure-guest run must not have waited on the previous run's stall.
      expect(Date.now() - started).toBeLessThan(250);
    } finally {
      isolated.dispose();
    }
  });

  it('survives dispose() while a run is parked on host work (#1922 class)', async () => {
    // The host-work drain is the first `await` between `evalCode` and the
    // `finally` that frees the eval-result handle. A dispose landing in that
    // window used to leave the handle alive, and `JS_FreeRuntime` then trips
    // `assert(list_empty(&rt->gc_obj_list))` — which poisons the shared WASM
    // module for the rest of the document, not just this sandbox.
    const isolated = await createSandbox(stalledSdk(), { limits: { timeoutMs: 5_000 } });
    // The disposal below is the subject, not the cleanup — but it is also the
    // only thing that frees this realm, so a failing assertion before it would
    // leak a QuickJS sandbox into the rest of the suite, which is the same
    // neighbourhood as the bug the test is about. `dispose()` is idempotent, so
    // the guarantee here only does work if the test threw before reaching it.
    try {
      const pending = isolated.eval(STALL_SCRIPT).catch((err: unknown) => err);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(() => isolated.dispose()).not.toThrow();
      expect(isSandboxRuntimeAborted()).toBe(false);

      const settled = await pending;
      expect(settled).toBeInstanceOf(Error);
      expect((settled as Error).message).toContain('Sandbox disposed');

      // The real oracle: a module left in the aborted state cannot run anything
      // afterwards, so a fresh sandbox still working is what proves it is intact.
      const fresh = await createSandbox(sdkWithClash());
      try {
        expect((await fresh.eval('1 + 1')).value).toBe(2);
      } finally {
        fresh.dispose();
      }
    } finally {
      isolated.dispose();
    }
  });
});

describe('#2305 — ClashElement.tag at the bridge boundary', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox(sdkWithClash());
  });

  afterEach(() => {
    sandbox.dispose();
  });

  it('names the offending element instead of throwing an unhandled TypeError', async () => {
    const script = `
      const elements = ${JSON.stringify([cube('a', 0, 'IfcWall'), cube('b', 0.5)])};
      bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
    `;
    const error = await sandbox.eval(script).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ScriptError);
    const message = (error as ScriptError).message;
    // The production message named nothing: "Cannot read properties of
    // undefined (reading 'toUpperCase')".
    expect(message).toContain('bim.clash.run: elements[1].tag');
    expect(message).toContain('IFC type name');
    expect(message).not.toContain('toUpperCase');
    // The bridge prefixes only what is not already attributed: a `call:` that
    // names itself must not come back as "bim.clash.run: bim.clash.run: ...".
    expect(message).not.toContain('bim.clash.run: bim.clash.run');
    await flushRejections();
    expect(crashSignature()).toEqual([]);
  });

  it('rejects the same shape through bim.clash.matrix', async () => {
    const script = `
      const elements = ${JSON.stringify([cube('a', 0)])};
      bim.clash.matrix(elements, {});
    `;
    const error = await sandbox.eval(script).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).message).toContain('bim.clash.matrix: elements[0].tag');
    await flushRejections();
    expect(crashSignature()).toEqual([]);
  });

  it('is catchable inside the script, so a run can recover', async () => {
    const script = `
      const elements = ${JSON.stringify([cube('a', 0)])};
      let caught = 'none';
      try { bim.clash.run(elements, ${JSON.stringify(RULES)}, {}); } catch (err) { caught = err.message; }
      caught;
    `;
    const result = await sandbox.eval(script);
    expect(String(result.value)).toContain('elements[0].tag must be a non-empty string');
    await flushRejections();
    expect(crashSignature()).toEqual([]);
  });
});

/**
 * A test-only namespace, appended to `NAMESPACE_SCHEMAS` for the duration of a
 * test, that exposes the *same* method twice: once synchronous, once returning
 * a host promise. Every schema method shipped today declares `returns: 'value'`,
 * for which `marshalReturn` and `marshalValue` happen to coincide — so nothing
 * in the real schema can tell the two conversions apart. These probes can.
 */
const PROBE: NamespaceSchema = {
  name: 'probe2305',
  doc: 'test-only probe (#2305)',
  permission: 'query',
  methods: [
    {
      name: 'syncString',
      doc: 'returns: string, synchronously',
      args: ['dump'],
      call: (_sdk, args) => args[0],
      returns: 'string',
    },
    {
      name: 'asyncString',
      doc: 'returns: string, via a host promise',
      args: ['dump'],
      call: (_sdk, args) => Promise.resolve(args[0]),
      returns: 'string',
    },
    {
      name: 'syncVoid',
      doc: 'returns: void, synchronously',
      args: ['dump'],
      call: () => 'ignored',
      returns: 'void',
    },
    {
      name: 'asyncVoid',
      doc: 'returns: void, via a host promise',
      args: ['dump'],
      call: () => Promise.resolve('ignored'),
      returns: 'void',
    },
  ],
};

describe('#2305 — an async result is converted by its declared ReturnType', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    NAMESPACE_SCHEMAS.push(PROBE);
    sandbox = await createSandbox(sdkWithClash());
  });

  afterEach(() => {
    sandbox.dispose();
    const at = NAMESPACE_SCHEMAS.indexOf(PROBE);
    if (at !== -1) NAMESPACE_SCHEMAS.splice(at, 1);
  });

  it("applies returns:'string' to an async result exactly as to a sync one", async () => {
    // `marshalReturn` renders a non-string as `vm.null` for a `string` method.
    // Marshalling the resolved value with `marshalValue` instead would leak the
    // number straight through, so the two calls would disagree.
    const result = await sandbox.eval(`
      (async () => ({
        sync: bim.probe2305.syncString(42),
        async: await bim.probe2305.asyncString(42),
        syncOk: bim.probe2305.syncString('IfcWall'),
        asyncOk: await bim.probe2305.asyncString('IfcWall'),
      }))();
    `);
    expect(result.value).toEqual({
      type: 'fulfilled',
      value: { sync: null, async: null, syncOk: 'IfcWall', asyncOk: 'IfcWall' },
    });
  });

  it("applies returns:'void' to an async result exactly as to a sync one", async () => {
    const result = await sandbox.eval(`
      (async () => ({
        sync: bim.probe2305.syncVoid(1) === undefined,
        async: (await bim.probe2305.asyncVoid(1)) === undefined,
      }))();
    `);
    expect(result.value).toEqual({ type: 'fulfilled', value: { sync: true, async: true } });
  });
});

describe('#2305 — the rejection path cannot strand the guest promise', () => {
  it('still rejects when the rejection value cannot be described', async () => {
    // Reading `.message` or coercing this value throws, so the code that builds
    // the error message throws before `deferred.reject` would run. An unsettled
    // guest promise is the same never-delivered failure this PR removes.
    const hostile = {
      toString() { throw new Error('toString exploded'); },
      [Symbol.toPrimitive]() { throw new Error('toPrimitive exploded'); },
    };
    const failing = {
      clash: { run: () => Promise.reject(hostile) },
    } as unknown as BimContext;
    const isolated = await createSandbox(failing, { limits: { timeoutMs: 2_000 } });
    try {
      const result = await isolated.eval(`
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
        (async () => {
          try {
            await bim.clash.run(elements, ${JSON.stringify(RULES)}, {});
            return 'never settled or resolved';
          } catch (err) {
            return 'rejected: ' + err.message;
          }
        })();
      `);
      const settled = result.value as { type: string; value: string };
      expect(settled.type).toBe('fulfilled');
      expect(settled.value).toContain('rejected:');
      expect(settled.value).toContain('bim.clash.run');
    } finally {
      isolated.dispose();
    }
  });
});

describe('#2305 — the tag validator cannot throw on the value it rejects', () => {
  const runCall = buildClashNamespace().methods.find((m) => m.name === 'run')?.call;

  /** Invoke the schema `call:` directly: a bigint or symbol cannot survive `vm.dump`. */
  function validate(tag: unknown): string {
    if (!runCall) throw new Error('bim.clash.run schema method missing');
    try {
      runCall({} as never, [[{ key: 'a', ref: 1, model: 'm', tag }], RULES, {}], { sandboxSessionId: 't' });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected the validator to reject this tag');
  }

  it('describes a bigint instead of throwing while formatting it', () => {
    // `JSON.stringify(1n)` throws outright, so the validator's own error path
    // failed on exactly the kind of bad value it exists to report.
    expect(validate(1n)).toContain('Got a bigint.');
  });

  it('distinguishes symbol, function and undefined from each other', () => {
    // All three render as the literal `undefined` under `JSON.stringify`.
    expect(validate(Symbol('IfcWall'))).toContain('Got a symbol.');
    expect(validate(() => 'IfcWall')).toContain('Got a function.');
    expect(validate(undefined)).toContain('Got undefined.');
    expect(validate('')).toContain('Got an empty string.');
    expect(validate(7)).toContain('Got the number 7.');
  });
});
