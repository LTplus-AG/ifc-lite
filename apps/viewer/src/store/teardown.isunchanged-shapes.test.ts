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
import { composeTeardown, defineSliceTeardown, type TeardownState } from './teardown.js';

const SESSION_RESET = { kind: 'session-reset' } as const;

describe('isUnchanged sees through a rebuilt-but-equal Map<string, plain object> value', () => {
  it('does not rewrite a clashReviews entry whose object was cloned with equal fields', () => {
    const prior = new Map([['g1:r1', { status: 'resolved' as const, comment: 'ok', updatedAt: 5 }]]);
    const rebuilt = new Map([['g1:r1', { status: 'resolved' as const, comment: 'ok', updatedAt: 5 }]]);
    assert.notStrictEqual(rebuilt.get('g1:r1'), prior.get('g1:r1'), 'fixture must use a cloned value, not the same reference');

    const registry = [
      defineSliceTeardown('testSlice', ['clashReviews'], () => ({ clashReviews: rebuilt })),
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
      defineSliceTeardown('testSlice', ['clashSolidMesh'], () => ({ clashSolidMesh: rebuilt })),
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
      defineSliceTeardown('testSlice', ['collabDraftBaseline'], () => ({
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
      defineSliceTeardown('testSlice', ['sectionPlane'], () => ({
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
