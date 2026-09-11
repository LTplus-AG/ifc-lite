/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compile-time guard for #4357: an external consumer building on
 * `Renderer.getScene()` reported four `Scene` members that were reachable
 * on the class but absent from the narrowed `SceneContents` surface —
 * `getMeshData`, `forEachMeshData`, `getEntityTransform`,
 * `getEntityLocalBounds`. `SceneContents` is a hand-maintained measurement
 * (see the module doc in `scene-contents.ts`), so nothing stops one of
 * these four being dropped again by a future edit that doesn't touch
 * `Scene` itself.
 *
 * These are type-level checks: each line below reads a key off
 * `SceneContents`. If a key is missing, TypeScript reports
 * `TS2339: Property '<name>' does not exist on type 'SceneContents'` at
 * that line, and the assigned function literal's parameter/return types
 * catch a signature that drifts without the member disappearing outright.
 * There is nothing to assert at runtime for a type-only change — a
 * regression here would otherwise pass an ordinary test unchanged, which
 * is why this file exists separately from `renderer-render-paths.test.ts`
 * and is exercised through `node ../../scripts/typecheck-tests.mjs`
 * (the repo's dedicated lane for test-only type errors, #2457) rather than
 * through `tsc`'s normal src-only program.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SceneContents } from './scene-contents.js';
import type { MeshData } from '@ifc-lite/geometry';

describe('#4357 SceneContents exposes the four measured Scene members', () => {
  it('getMeshData: the single-mesh accessor', () => {
    const fn: SceneContents['getMeshData'] = (
      expressId: number,
      modelIndex?: number,
    ): MeshData | undefined => {
      assert.equal(typeof expressId, 'number');
      assert.ok(modelIndex === undefined || typeof modelIndex === 'number');
      return undefined;
    };
    assert.equal(typeof fn, 'function');
  });

  it('forEachMeshData: visits every flat mesh piece', () => {
    const fn: SceneContents['forEachMeshData'] = (visit: (md: MeshData) => void): void => {
      assert.equal(typeof visit, 'function');
    };
    assert.equal(typeof fn, 'function');
  });

  it('getEntityTransform: row-major 4x4 local-to-world, f64 precision', () => {
    const fn: SceneContents['getEntityTransform'] = (expressId: number): Float64Array | null => {
      assert.equal(typeof expressId, 'number');
      return null;
    };
    assert.equal(typeof fn, 'function');
  });

  it('getEntityLocalBounds: pre-transform bounds unioned across occurrences', () => {
    const fn: SceneContents['getEntityLocalBounds'] = (
      expressId: number,
    ): { min: [number, number, number]; max: [number, number, number] } | null => {
      assert.equal(typeof expressId, 'number');
      return null;
    };
    assert.equal(typeof fn, 'function');
  });
});
