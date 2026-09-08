/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Follow-up to #3346's adversarial audit: `isUnchanged` (`teardown.ts`) saw
 * through `Set` / `Map` / array, but three shapes still fell to its final
 * `return false` even when content was equal:
 *
 *  1. a `Map` VALUE that is a plain object (the `Map` branch recurses, but a
 *     plain-object comparison had no branch of its own);
 *  2. a `Set` of objects (`Set.has` is reference-based — documented as a
 *     known limit below, not fixed here, see the comment in `teardown.ts`);
 *  3. a typed array (`Array.isArray` is `false` for e.g. `Float32Array`).
 *
 * Neither (1)'s `Map` example nor (3) is wired into `composeTeardown` by any
 * REGISTERED slice today — `clashSlice` / `collabSlice` own the typed-array
 * fields (`clashSolidMesh`, `collabDraftBaseline`) and Map-of-object field
 * (`clashReviews`) this suite uses, but neither slice has a `defineSliceTeardown`
 * (`grep -L defineSliceTeardown` over `slices/*.ts` confirms it), so these are
 * closed as dormant blind spots, exercised here directly through the exported
 * `composeTeardown` with a synthetic single-entry registry rather than through
 * `viewerTeardown` (which cannot reach them, for the same reason).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { composeTeardown, defineSliceTeardown, notApplicable, type SliceTeardownArms, type TeardownState } from './teardown.js';
import type { ViewerState } from './index.js';

/**
 * Every registry below is a session-reset probe: `isUnchanged` is only ever
 * consulted on the reset path. Spelling the other two arms out 18 times would
 * bury that, so they are `notApplicable` once, here.
 */
function sessionResetOnly<const K extends keyof ViewerState>(
  slice: string,
  owns: readonly K[],
  arm: SliceTeardownArms<K>['session-reset'],
) {
  return defineSliceTeardown(slice, owns, {
    'session-reset': arm,
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  });
}

const SESSION_RESET = { kind: 'session-reset' } as const;

describe('isUnchanged sees through a rebuilt-but-equal Map<string, plain object> value', () => {
  it('does not rewrite a clashReviews entry whose object was cloned with equal fields', () => {
    const prior = new Map([['g1:r1', { status: 'resolved' as const, comment: 'ok', updatedAt: 5 }]]);
    const rebuilt = new Map([['g1:r1', { status: 'resolved' as const, comment: 'ok', updatedAt: 5 }]]);
    assert.notStrictEqual(rebuilt.get('g1:r1'), prior.get('g1:r1'), 'fixture must use a cloned value, not the same reference');

    const registry = [
      sessionResetOnly('testSlice', ['clashReviews'], () => ({ clashReviews: rebuilt })),
    ];
    const state: TeardownState = { clashReviews: prior };
    const patch = composeTeardown(registry)(SESSION_RESET, state);

    assert.ok(
      !('clashReviews' in patch),
      'clashReviews must not be rewritten: the rebuilt Map holds an equal-but-new object per key',
    );
  });
});

describe('isUnchanged sees through a rebuilt-but-equal typed array', () => {
  it('does not rewrite a clashSolidMesh whose Float64Array/Uint32Array were rebuilt with equal contents', () => {
    const prior = { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const rebuilt = { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    assert.notStrictEqual(rebuilt.positions, prior.positions, 'fixture must use a cloned typed array, not the same reference');

    const registry = [
      sessionResetOnly('testSlice', ['clashSolidMesh'], () => ({ clashSolidMesh: rebuilt })),
    ];
    const state: TeardownState = { clashSolidMesh: prior };
    const patch = composeTeardown(registry)(SESSION_RESET, state);

    assert.ok(
      !('clashSolidMesh' in patch),
      'clashSolidMesh must not be rewritten: the rebuilt mesh has element-wise-equal typed arrays',
    );
  });

  it('still rewrites a typed array whose contents actually differ', () => {
    const registry = [
      sessionResetOnly('testSlice', ['collabDraftBaseline'], () => ({
        collabDraftBaseline: new Uint8Array([9, 9]),
      })),
    ];
    const state: TeardownState = { collabDraftBaseline: new Uint8Array([1, 2]) };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('collabDraftBaseline' in patch, 'a typed array with different contents must still be written');
  });
});

describe('isUnchanged compares plain-object keys by OWNERSHIP, not the prototype chain (#3392 follow-up)', () => {
  it('still rewrites when two objects share no own keys, even though a key each has via the shared Object prototype makes `k in b` true', () => {
    // `Object.prototype.toString` / `Object.prototype.valueOf` are inherited
    // by every plain object -- so `'toString' in rebuilt` is true even though
    // `rebuilt` does not OWN a `toString` key of its own, and `a.toString`/
    // `rebuilt.toString` are Object.is-equal because both resolve to the same
    // inherited function. A comparison keyed on `in` therefore reports these
    // two objects -- which share NO own key -- as unchanged.
    const prior = { toString: Object.prototype.toString };
    const rebuilt = { valueOf: Object.prototype.valueOf };

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);

    assert.ok(
      'sectionPlane' in patch,
      'two objects with completely different own keys must be written as changed -- ' +
      '`k in b` treats a key inherited from Object.prototype as if b owned it too',
    );
  });
});

describe('isUnchanged walks symbol-keyed own properties, not just string keys (#3392 follow-up)', () => {
  it('reports two plain objects as changed when they differ only at a shared own enumerable symbol key', () => {
    const marker = Symbol('marker');
    const prior = { foo: 1, [marker]: 'old' };
    const rebuilt = { foo: 1, [marker]: 'new' };

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);

    assert.ok(
      'sectionPlane' in patch,
      'two objects identical across every own string key but differing at a shared own enumerable ' +
      'SYMBOL key must compare "changed" -- `Object.keys` alone cannot see the symbol key',
    );
  });
});

describe('isUnchanged compares typed-array elements with `Object.is` (#3392 follow-up)', () => {
  it('reports a same-position NaN as unchanged, because the arrays really are equal', () => {
    // `Object.is(NaN, NaN)` is `true`, and that is the right answer: two arrays
    // identical element-for-element including a NaN are equal, so skipping the
    // write drops nothing real. `===` would report "changed" here and force a
    // redundant write -- wasteful rather than wrong, but not the correct answer.
    const registry = [
      sessionResetOnly('testSlice', ['clashSolidMesh'], () => ({
        clashSolidMesh: { positions: new Float64Array([NaN, 0, 0]), indices: new Uint32Array([0]) },
      })),
    ];
    const state: TeardownState = {
      clashSolidMesh: { positions: new Float64Array([NaN, 0, 0]), indices: new Uint32Array([0]) },
    };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok(!('clashSolidMesh' in patch), 'two NaNs at the same position must compare "unchanged"');
  });

  it('reports -0 vs 0 as changed, so a real sign flip is never silently dropped', () => {
    // `-0 === 0` is `true`, so a `===` comparator reports this pair "unchanged"
    // and the write is dropped -- a genuine difference lost, the same shape as
    // the `k in b` prototype-chain bug this PR also fixes. `Object.is(-0, 0)` is
    // `false`, so the write goes through.
    const registry = [
      sessionResetOnly('testSlice', ['clashSolidMesh'], () => ({
        clashSolidMesh: { positions: new Float64Array([-0, 0, 0]), indices: new Uint32Array([0]) },
      })),
    ];
    const state: TeardownState = {
      clashSolidMesh: { positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) },
    };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('clashSolidMesh' in patch, '-0 vs 0 at the same position must compare "changed"');
  });
});

describe('isUnchanged sees a content-different Map/Set as changed (#3346 core guarantee)', () => {
  it('reports two content-different Maps as changed', () => {
    const registry = [
      sessionResetOnly('testSlice', ['clashReviews'], () => ({
        clashReviews: new Map([['g1:r1', { status: 'open' as const, comment: 'different', updatedAt: 9 }]]),
      })),
    ];
    const state: TeardownState = {
      clashReviews: new Map([['g1:r1', { status: 'resolved' as const, comment: 'ok', updatedAt: 5 }]]),
    };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('clashReviews' in patch, 'a Map whose value actually differs at a shared key must compare "changed"');
  });

  it('reports two content-different Sets as changed', () => {
    const registry = [
      sessionResetOnly('testSlice', ['selectedStoreys'], () => ({
        selectedStoreys: new Set([1, 3]),
      })),
    ];
    const state: TeardownState = { selectedStoreys: new Set([1, 2]) };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('selectedStoreys' in patch, 'a Set whose members actually differ must compare "changed"');
  });
});

describe('isUnchanged excludes Date/RegExp/class instances from the plain-object structural compare (#3392 follow-up)', () => {
  it('reports two different Date instances with the same timestamp as changed', () => {
    // `Date` has zero own enumerable keys, so a plain-object comparison would
    // vacuously report ANY two Date instances "unchanged" (the zero-own-keys
    // trap this PR exists to close). Excluding it via the prototype check keeps
    // it on the safe `return false` path instead.
    const t = 1_700_000_000_000;
    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: new Date(t) as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: new Date(t) as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('sectionPlane' in patch, 'two Date instances must never be treated as structurally equal plain objects');
  });

  it('reports two different RegExp instances with the same source/flags as changed', () => {
    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: /abc/g as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: /abc/g as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('sectionPlane' in patch, 'two RegExp instances must never be treated as structurally equal plain objects');
  });

  it('reports two different instances of a custom class with equal fields as changed', () => {
    class Point {
      constructor(public x: number) {}
    }
    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: new Point(1) as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: new Point(1) as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok(
      'sectionPlane' in patch,
      'two class instances with an equal own field must still compare "changed" -- the prototype check ' +
      'excludes them from the plain-object branch regardless of field content',
    );
  });
});

describe('isUnchanged runs Object.create(null) through structural compare, not a blanket answer (#3392 follow-up)', () => {
  it('drops a null-prototype value whose content is unchanged', () => {
    const prior = Object.create(null);
    prior.x = 1;
    const rebuilt = Object.create(null);
    rebuilt.x = 1;

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok(!('sectionPlane' in patch), 'two null-prototype objects with equal content must compare "unchanged"');
  });

  it('keeps a null-prototype value whose content differs', () => {
    const prior = Object.create(null);
    prior.x = 1;
    const rebuilt = Object.create(null);
    rebuilt.x = 2;

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('sectionPlane' in patch, 'two null-prototype objects with different content must compare "changed"');
  });
});

describe('isUnchanged falls through a detected cycle to "changed", never loops or reports a false "unchanged" (#3392 follow-up)', () => {
  it('reports two independently-built, unequal-by-reference, self-referential objects as changed', () => {
    const prior: Record<string, unknown> = {};
    prior.self = prior;
    const rebuilt: Record<string, unknown> = {};
    rebuilt.self = rebuilt;

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);

    assert.ok(
      'sectionPlane' in patch,
      'a cycle detected mid-comparison must fall through to "changed" (a redundant write, never a dropped one), not loop or report a false "unchanged"',
    );
  });
});

describe('isUnchanged\'s recursion depth is fresh per top-level call (#3392 follow-up)', () => {
  it('does not leak recursion state from one composeTeardown call into the next', () => {
    const shared = { v: 1 };

    // First call: `shared` genuinely differs from `different`, walking the
    // plain-object branch several `depth` levels deep inside THIS call.
    const different = { v: 2 };
    const firstRegistry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: different as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const firstState: TeardownState = { sectionPlane: shared as unknown as TeardownState['sectionPlane'] };
    const firstPatch = composeTeardown(firstRegistry)(SESSION_RESET, firstState);
    assert.ok('sectionPlane' in firstPatch, 'sanity check: the first call must report the genuinely different value as changed');

    // Second, SEPARATE top-level call reusing the SAME `shared` reference, this
    // time against an equal-but-new object. Each top-level `isUnchanged` call
    // starts `depth` back at 0 (its default parameter), so a deep first call
    // must not leave the second call artificially depth-capped.
    const equalButNew = { v: 1 };
    const secondRegistry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: equalButNew as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const secondState: TeardownState = { sectionPlane: shared as unknown as TeardownState['sectionPlane'] };
    const secondPatch = composeTeardown(secondRegistry)(SESSION_RESET, secondState);

    assert.ok(
      !('sectionPlane' in secondPatch),
      'a second, separate top-level call comparing the same reference against an equal-but-new object must still report "unchanged"',
    );
  });
});

describe('isUnchanged is order-sensitive for plain arrays (#3392 follow-up)', () => {
  it('reports [1, 2] vs [2, 1] as changed', () => {
    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: [2, 1] as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: [1, 2] as unknown as TeardownState['sectionPlane'] };
    const patch = composeTeardown(registry)(SESSION_RESET, state);
    assert.ok('sectionPlane' in patch, 'two arrays with the same elements in a different order must compare "changed"');
  });
});

describe('isUnchanged bounds Map/array recursion, which the object cycle guard above never covered (#3392 follow-up)', () => {
  it('reports two self-referential arrays as changed instead of exhausting the stack', () => {
    const prior: unknown[] = [];
    prior.push(prior);
    const rebuilt: unknown[] = [];
    rebuilt.push(rebuilt);

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };

    let patch: ReturnType<ReturnType<typeof composeTeardown>>;
    assert.doesNotThrow(() => {
      patch = composeTeardown(registry)(SESSION_RESET, state);
    }, 'a self-referential array must not recurse until the call stack is exhausted');
    assert.ok(patch! && 'sectionPlane' in patch!, 'an uncomparable (depth-capped) pair must fall through to "changed", not a false "unchanged"');
  });

  it('reports two self-referential Maps as changed instead of exhausting the stack', () => {
    const prior = new Map<string, unknown>();
    prior.set('self', prior);
    const rebuilt = new Map<string, unknown>();
    rebuilt.set('self', rebuilt);

    const registry = [
      sessionResetOnly('testSlice', ['sectionPlane'], () => ({
        sectionPlane: rebuilt as unknown as TeardownState['sectionPlane'],
      })),
    ];
    const state: TeardownState = { sectionPlane: prior as unknown as TeardownState['sectionPlane'] };

    let patch: ReturnType<ReturnType<typeof composeTeardown>>;
    assert.doesNotThrow(() => {
      patch = composeTeardown(registry)(SESSION_RESET, state);
    }, 'a self-referential Map must not recurse until the call stack is exhausted');
    assert.ok(patch! && 'sectionPlane' in patch!, 'an uncomparable (depth-capped) pair must fall through to "changed", not a false "unchanged"');
  });
});
