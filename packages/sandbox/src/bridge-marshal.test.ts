/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Value marshalling across the QuickJS boundary — the three conversions every
 * `bim.*` call goes through, none of which had a test.
 *
 * 1. `entityRefs` unmarshalling. The schema documents it as "array of
 *    entities, map to .ref", and that mapping is what lets a script pass
 *    `bim.query.byType(...)` results straight into `bim.viewer.colorize(...)`.
 *    Dropping the `?? r` unwrap left the suite green.
 * 2. `returns: 'string'` marshalling, which answers `null` — not a coerced
 *    string — when the SDK hands back a non-string.
 * 3. The `marshalValue` cycle guard, which is scoped to the *ancestor chain*.
 *    Removing objects from the guard on exit is the difference between an
 *    acyclic graph that shares a sub-object across siblings serialising in
 *    full and its second occurrence silently becoming `null`. Making the
 *    guard permanent (never deleting on exit) left the suite green.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext, EntityRef } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

/** Permissions for a sandbox that only needs `bim.export`. */
const EXPORT_ONLY = {
  model: false,
  query: false,
  viewer: false,
  mutate: false,
  store: false,
  lens: false,
  export: true,
  files: false,
} as const;

/** Build a stub BimContext whose `export` namespace records and answers. */
function stubSdk(overrides: {
  csv?: (refs: EntityRef[], options: unknown) => unknown;
  json?: (refs: EntityRef[], columns: unknown) => unknown;
}): { sdk: BimContext; calls: { csvRefs: EntityRef[][] } } {
  const calls = { csvRefs: [] as EntityRef[][] };
  const sdk = {
    export: {
      csv: (refs: EntityRef[], options: unknown) => {
        calls.csvRefs.push(refs);
        return overrides.csv ? overrides.csv(refs, options) : '';
      },
      json: (refs: EntityRef[], columns: unknown) =>
        overrides.json ? overrides.json(refs, columns) : [],
    },
  } as unknown as BimContext;
  return { sdk, calls };
}

async function withSandbox<T>(
  sdk: BimContext,
  fn: (evalCode: (code: string) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const sandbox = await createSandbox(sdk, { permissions: EXPORT_ONLY });
  try {
    return await fn(async (code) => (await sandbox.eval(code, { typescript: false })).value);
  } finally {
    sandbox.dispose();
  }
}

describe('entityRefs argument unmarshalling', () => {
  it('unwraps the .ref of each entity before the SDK sees it', async () => {
    const { sdk, calls } = stubSdk({});
    await withSandbox(sdk, async (run) => {
      await run(`bim.export.csv(
        [
          { ref: { modelId: 'm1', expressId: 7 }, name: 'Wall A', type: 'IfcWall' },
          { ref: { modelId: 'm1', expressId: 9 }, name: 'Wall B', type: 'IfcWall' },
        ],
        { columns: ['Name'] },
      )`);
    });

    expect(calls.csvRefs).toHaveLength(1);
    // The SDK must receive bare EntityRefs — NOT the wrapper objects. The
    // `name`/`type` fields above exist so a mutant that forwards the entity
    // unchanged is visibly different rather than accidentally equal.
    expect(calls.csvRefs[0]).toEqual([
      { modelId: 'm1', expressId: 7 },
      { modelId: 'm1', expressId: 9 },
    ]);
  });

  it('passes an already-bare ref through untouched', async () => {
    const { sdk, calls } = stubSdk({});
    await withSandbox(sdk, async (run) => {
      await run(`bim.export.csv([{ modelId: 'm2', expressId: 3 }], { columns: [] })`);
    });
    expect(calls.csvRefs[0]).toEqual([{ modelId: 'm2', expressId: 3 }]);
  });

  it('answers an empty list when the argument is omitted', async () => {
    const { sdk, calls } = stubSdk({});
    await withSandbox(sdk, async (run) => {
      await run(`bim.export.csv()`);
    });
    expect(calls.csvRefs[0]).toEqual([]);
  });
});

describe("returns: 'string' marshalling", () => {
  it('hands a string back as a string', async () => {
    const { sdk } = stubSdk({ csv: () => 'Name\nWall A\n' });
    const value = await withSandbox(sdk, (run) =>
      run(`bim.export.csv([], { columns: ['Name'] })`),
    );
    expect(value).toBe('Name\nWall A\n');
  });

  it('answers null for a non-string, rather than coercing it', async () => {
    // A coercing marshaller would hand the script "[object Object]" / "42" and
    // let a broken SDK return read as real CSV text.
    for (const [returned, label] of [
      [{ rows: 1 }, 'object'],
      [42, 'number'],
      [undefined, 'undefined'],
    ] as const) {
      const { sdk } = stubSdk({ csv: () => returned });
      const value = await withSandbox(sdk, (run) =>
        run(`bim.export.csv([], { columns: [] })`),
      );
      expect(value, `non-string return of type ${label}`).toBeNull();
    }
  });
});

describe('marshalValue typed-array handling', () => {
  it('marshals a Uint8Array as a real, indexable script array', async () => {
    // A typed array's own enumerable properties ARE its numeric indices, so
    // walking one with the generic-object branch (Object.entries) used to
    // hand the script `{ "0": 73, "1": 70, "2": 67 }` — no `.length`, and
    // `Array.isArray()` false. `bim.export.ifc()` returns exactly this shape
    // once STEP output exceeds V8's string-length limit and falls back to
    // `Uint8Array` chunks (step-exporter.ts): small models marshal fine,
    // large ones silently hand the script junk.
    const { sdk } = stubSdk({ json: () => new Uint8Array([73, 70, 67]) });
    const value = await withSandbox(sdk, (run) =>
      run(
        `const r = bim.export.json([], []); JSON.stringify({ isArray: Array.isArray(r), length: r.length, values: r })`,
      ),
    );
    expect(value).toBe('{"isArray":true,"length":3,"values":[73,70,67]}');
  });

  it('marshals a Float64Array element inside a plain array the same way', async () => {
    const { sdk } = stubSdk({ json: () => ({ samples: new Float64Array([1.5, 2.5]) }) });
    const value = await withSandbox(sdk, (run) => run(`bim.export.json([], [])`));
    expect(value).toEqual({ samples: [1.5, 2.5] });
  });
});

describe('marshalValue cycle guard', () => {
  it('serialises a sub-object shared between siblings in full, both times', async () => {
    // Acyclic: `shared` appears twice, but never inside itself. Both
    // occurrences must survive — a guard that never releases an object on the
    // way out would null the second one.
    const shared = { unit: 'm', factor: 0.001 };
    const { sdk } = stubSdk({ json: () => ({ a: shared, b: shared }) });
    const value = await withSandbox(sdk, (run) => run(`bim.export.json([], [])`));
    expect(value).toEqual({
      a: { unit: 'm', factor: 0.001 },
      b: { unit: 'm', factor: 0.001 },
    });
  });

  it('serialises the same object repeated down a sibling list', async () => {
    const shared = { id: 1 };
    const { sdk } = stubSdk({ json: () => [shared, shared, shared] });
    const value = await withSandbox(sdk, (run) => run(`bim.export.json([], [])`));
    expect(value).toEqual([{ id: 1 }, { id: 1 }, { id: 1 }]);
  });

  it('still cuts a genuine cycle rather than recursing forever', async () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const { sdk } = stubSdk({ json: () => cyclic });
    const value = await withSandbox(sdk, (run) => run(`bim.export.json([], [])`));
    expect(value).toEqual({ name: 'root', self: null });
  });

  it('cuts a cycle that closes through an intermediate object', async () => {
    const root: Record<string, unknown> = { level: 0 };
    const child: Record<string, unknown> = { level: 1, back: root };
    root.child = child;
    const { sdk } = stubSdk({ json: () => root });
    const value = await withSandbox(sdk, (run) => run(`bim.export.json([], [])`));
    expect(value).toEqual({ level: 0, child: { level: 1, back: null } });
  });
});
