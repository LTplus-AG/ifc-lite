/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hasNoRenderableTarget, resolvePresentationColorMap } from './resolvePresentationIds.js';

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

describe('resolvePresentationColorMap (#3338, the colour channel)', () => {
  const ASSEMBLY = 42;
  const PART_A = 9001;
  const PART_B = 9002;
  const red: readonly number[] = [1, 0, 0, 1];
  const blue: readonly number[] = [0, 0, 1, 1];
  const resolver = (ids: number[]) =>
    ids.flatMap((id) => (id === ASSEMBLY ? [PART_A, PART_B] : [id]));

  it('carries an assembly colour down to its parts', () => {
    const out = resolvePresentationColorMap(resolver, [[ASSEMBLY, red]]);
    assert.deepEqual([...out.entries()].sort((a, b) => a[0] - b[0]), [
      [ASSEMBLY, red],
      [PART_A, red],
      [PART_B, red],
    ]);
  });

  it('lets an explicitly named id keep its own colour whichever order it arrives in', () => {
    const partFirst = resolvePresentationColorMap(resolver, [[PART_B, blue], [ASSEMBLY, red]]);
    const partLast = resolvePresentationColorMap(resolver, [[ASSEMBLY, red], [PART_B, blue]]);
    assert.deepEqual(partFirst.get(PART_B), blue, 'explicit colour survives an earlier position');
    assert.deepEqual(partLast.get(PART_B), blue, 'and a later one');
    assert.deepEqual(partFirst.get(PART_A), red, 'the part reached only via the assembly stays red');
  });

  it('groups by colour so the resolver is called once per distinct colour, not once per id', () => {
    const calls: number[][] = [];
    const counting = (ids: number[]) => {
      calls.push([...ids]);
      return resolver(ids);
    };
    resolvePresentationColorMap(counting, [[1, red], [2, red], [3, blue]]);
    assert.deepEqual(calls, [[1, 2], [3]]);
  });

  it('without a resolver, keeps every raw pairing rather than dropping the call', () => {
    const out = resolvePresentationColorMap(undefined, [[ASSEMBLY, red]]);
    assert.deepEqual([...out.entries()], [[ASSEMBLY, red]]);
  });
});
