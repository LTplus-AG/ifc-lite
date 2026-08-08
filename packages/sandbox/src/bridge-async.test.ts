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
import { createSandbox, ScriptError, type Sandbox } from './sandbox.js';

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

describe('#2305 — a host promise cannot hang the run', () => {
  it('times out a never-settling host promise instead of waiting forever', async () => {
    // The QuickJS interrupt handler only fires while *guest* code runs, so it
    // cannot see a host promise that never settles. The drain carries its own
    // deadline; without one this eval would never return.
    const stalled = {
      clash: { run: () => new Promise(() => { /* never settles */ }) },
    } as unknown as BimContext;
    const isolated = await createSandbox(stalled, { limits: { timeoutMs: 300 } });
    try {
      const script = `
        const elements = ${JSON.stringify([cube('a', 0, 'IfcWall')])};
        (async () => { await bim.clash.run(elements, ${JSON.stringify(RULES)}, {}); })();
      `;
      const started = Date.now();
      await expect(isolated.eval(script)).rejects.toThrow('interrupted');
      // Bounded by the run's own timeout, not by the test runner giving up.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      // Teardown with a deferred still outstanding must not abort the module.
      expect(() => isolated.dispose()).not.toThrow();
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
