/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Outline provider used by the drawing projection stage: origin folding,
 * WASM handle lifetime, and the once-per-generation failure log that keeps a
 * systematically-broken binding visible without one line per element.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  createMeshOutlineProvider,
  type MeshOutlineHandle,
  type MeshOutline2dFn,
} from './meshOutlineProvider.js';

/** A handle over one square contour, recording whether it was freed. */
function stubHandle(contours: Float32Array[]): MeshOutlineHandle & { freed: number } {
  return {
    axisMin: -1,
    axisMax: 3,
    contourCount: contours.length,
    contour: (i: number) => contours[i],
    free() { this.freed += 1; },
    freed: 0,
  };
}

const mesh = (positions: number[], origin?: number[]) => ({
  positions: new Float32Array(positions),
  indices: new Uint32Array([0, 1, 2]),
  ...(origin ? { origin } : {}),
});

let warnings: unknown[][];
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
});
afterEach(() => { console.warn = realWarn; });

describe('createMeshOutlineProvider', () => {
  it('folds the mesh origin into the positions handed to the binding', () => {
    let seen: Float32Array | null = null;
    const fn: MeshOutline2dFn = (positions) => {
      seen = positions;
      return stubHandle([new Float32Array([0, 0, 1, 1])]);
    };
    const provider = createMeshOutlineProvider(fn);
    provider(mesh([1, 2, 3], [10, 20, 30]), 'y', false);
    assert.deepStrictEqual(Array.from(seen!), [11, 22, 33]);
  });

  it('passes positions through untouched when the origin is absent or zero', () => {
    const seen: Float32Array[] = [];
    const fn: MeshOutline2dFn = (positions) => {
      seen.push(positions);
      return stubHandle([new Float32Array([0, 0, 1, 1])]);
    };
    const provider = createMeshOutlineProvider(fn);
    const noOrigin = mesh([1, 2, 3]);
    const zeroOrigin = mesh([4, 5, 6], [0, 0, 0]);
    provider(noOrigin, 'y', false);
    provider(zeroOrigin, 'y', false);
    // Same object, not a copy: the zero-origin path must not allocate.
    assert.strictEqual(seen[0], noOrigin.positions);
    assert.strictEqual(seen[1], zeroOrigin.positions);
  });

  it('maps the semantic axis to the binding axis code', () => {
    const codes: number[] = [];
    const fn: MeshOutline2dFn = (_p, _i, axis) => {
      codes.push(axis);
      return stubHandle([new Float32Array([0, 0, 1, 1])]);
    };
    const provider = createMeshOutlineProvider(fn);
    provider(mesh([1, 2, 3]), 'x', false);
    provider(mesh([1, 2, 3]), 'y', false);
    provider(mesh([1, 2, 3]), 'z', false);
    assert.deepStrictEqual(codes, [0, 1, 2]);
  });

  it('copies contours off the WASM heap and frees the handle', () => {
    const ring = new Float32Array([0, 0, 1, 0, 1, 1]);
    const handle = stubHandle([ring]);
    const provider = createMeshOutlineProvider(() => handle);
    const out = provider(mesh([1, 2, 3]), 'y', false);
    assert.ok(out);
    assert.strictEqual(handle.freed, 1);
    assert.notStrictEqual(out.contours[0], ring, 'contour must be copied off the WASM heap');
    assert.deepStrictEqual(Array.from(out.contours[0]), [0, 0, 1, 0, 1, 1]);
    assert.deepStrictEqual([out.axisMin, out.axisMax], [-1, 3]);
  });

  it('frees the handle and returns null when there are no contours', () => {
    const handle = stubHandle([]);
    const provider = createMeshOutlineProvider(() => handle);
    assert.strictEqual(provider(mesh([1, 2, 3]), 'y', false), null);
    assert.strictEqual(handle.freed, 1);
  });

  it('returns null without logging when the binding answers undefined', () => {
    const provider = createMeshOutlineProvider(() => undefined);
    assert.strictEqual(provider(mesh([1, 2, 3]), 'y', false), null);
    assert.strictEqual(warnings.length, 0, 'a no-outline answer is not a failure');
  });

  it('logs the FIRST binding failure once and stays quiet for the rest of the drawing', () => {
    // A wasm bundle whose meshOutline2d ABI no longer matches this JS throws
    // for EVERY mesh. Before the latch this was a bare `catch { return null }`:
    // an entire drawing silently downgraded to the TS silhouette with nothing
    // in the console. One line per element is equally unusable, so exactly one
    // line per generation is the contract.
    const boom = new Error('unreachable executed');
    const provider = createMeshOutlineProvider(() => { throw boom; });

    for (let i = 0; i < 50; i++) {
      assert.strictEqual(provider(mesh([1, 2, 3]), 'y', false), null);
    }

    assert.strictEqual(warnings.length, 1, 'exactly one warning for 50 failing meshes');
    assert.match(String(warnings[0][0]), /meshOutline2d failed/);
    assert.strictEqual(warnings[0][1], boom, 'the cause must be bound to the log');
  });

  it('reports again for the next drawing generation (the latch is per provider)', () => {
    const failing: MeshOutline2dFn = () => { throw new Error('unreachable executed'); };
    createMeshOutlineProvider(failing)(mesh([1, 2, 3]), 'y', false);
    createMeshOutlineProvider(failing)(mesh([1, 2, 3]), 'y', false);
    assert.strictEqual(warnings.length, 2, 'each generation gets its own budget');
  });

  it('reports a failure raised while reading contours, and still frees the handle', () => {
    const handle = stubHandle([]);
    const provider = createMeshOutlineProvider(() => ({
      ...handle,
      contourCount: 1,
      contour: () => { throw new Error('detached wasm memory'); },
      free() { handle.freed += 1; },
    }));
    assert.strictEqual(provider(mesh([1, 2, 3]), 'y', false), null);
    assert.strictEqual(handle.freed, 1, 'the finally must run before the catch');
    assert.strictEqual(warnings.length, 1);
  });
});
