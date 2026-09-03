/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hasNoRenderableTarget } from './resolveIsolationIds.js';

/** `hasGeometry` stand-in: exactly the ids whose mesh is on screen right now. */
const rendering = (...ids: number[]) => {
  const set = new Set(ids);
  return (id: number) => set.has(id);
};

describe('hasNoRenderableTarget (#3741, the warning gate for #3426)', () => {
  it('is quiet when a resolved id renders', () => {
    assert.equal(hasNoRenderableTarget([10], [10], rendering(10)), false);
  });

  it('is quiet when the assembly itself is mesh-less but a resolved part renders', () => {
    // The ordinary #3338 expansion: 10 has no mesh, its parts 11/12 do.
    assert.equal(hasNoRenderableTarget([10], [11, 12], rendering(11, 12)), false);
    assert.equal(hasNoRenderableTarget([10], [11, 12], rendering(12)), false);
  });

  it('fires when the #3426 fallback carried parts that none of them render', () => {
    // The case a `resolved.length === 0` test steps straight past: the
    // fallback in expandToGeometryBearingIds carries ALL aggregated parts
    // forward, so the set is non-empty while holding no mesh at all.
    assert.equal(hasNoRenderableTarget([10], [11, 12], rendering()), true);
  });

  it('fires when there was nothing to expand to at all', () => {
    assert.equal(hasNoRenderableTarget([10], [], rendering(99)), true);
  });

  it('never fires for an empty request', () => {
    assert.equal(hasNoRenderableTarget([], [], rendering()), false);
  });
});
