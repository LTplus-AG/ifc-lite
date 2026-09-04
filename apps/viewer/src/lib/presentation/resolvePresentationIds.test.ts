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

  // Two assemblies whose parts OVERLAP: 500 is a part of both. Nothing but the
  // entry order can decide its colour, and the grouped fast path cannot see
  // that order -- this is the case that forces the entry-by-entry fallback.
  const SHARED = 500;
  const ASM_X = 61;
  const ASM_Y = 62;
  const overlapping = (ids: number[]) =>
    ids.flatMap((id) => {
      if (id === ASM_X) return [SHARED, 501];
      if (id === ASM_Y) return [SHARED, 502];
      return [id];
    });

  it('gives a contested inherited id the colour of the LAST entry, not of the first colour seen', () => {
    const xThenY = resolvePresentationColorMap(overlapping, [[ASM_X, red], [ASM_Y, blue]]);
    assert.deepEqual(xThenY.get(SHARED), blue, 'ASM_Y is last, so the shared part is blue');
    assert.deepEqual(xThenY.get(501), red, "ASM_X's own part is unaffected");
    assert.deepEqual(xThenY.get(502), blue, "ASM_Y's own part is unaffected");
  });

  it('and the same in the opposite input order', () => {
    const yThenX = resolvePresentationColorMap(overlapping, [[ASM_Y, blue], [ASM_X, red]]);
    assert.deepEqual(yThenX.get(SHARED), red, 'ASM_X is last now, so the shared part is red');
    assert.deepEqual(yThenX.get(501), red);
    assert.deepEqual(yThenX.get(502), blue);
  });

  it('last-wins survives colour groups interleaving: blue, red, blue on one shared part ends blue', () => {
    // THE discriminating case. All three entries claim SHARED. Grouping by
    // colour collapses blue's two entries into one group that first appears at
    // index 0, so applying group by group runs blue then red and leaves SHARED
    // RED -- even though the last entry claiming it is blue. Ordering the
    // groups by their LAST entry instead does not fix it either: that is still
    // a per-group decision, and here both orderings are wrong for a different
    // reason each. Only resolving entry by entry answers it.
    const ASM_Z = 63;
    const threeClaims = (ids: number[]) =>
      ids.flatMap((id) => {
        if (id === ASM_X) return [SHARED, 501];
        if (id === ASM_Y) return [SHARED, 502];
        if (id === ASM_Z) return [SHARED, 503];
        return [id];
      });
    const out = resolvePresentationColorMap(threeClaims, [
      [ASM_Y, blue],
      [ASM_X, red],
      [ASM_Z, blue],
    ]);
    assert.deepEqual(
      out.get(SHARED),
      blue,
      'ASM_Z is the last entry claiming the shared part, so its blue wins -- not the red of ' +
      'the group that happens to be applied second',
    );
    assert.deepEqual(out.get(501), red, "the red assembly's own part stays red");
    assert.deepEqual(out.get(503), blue);
  });

  it('an explicit id still outranks a contested inherited one', () => {
    const out = resolvePresentationColorMap(overlapping, [
      [ASM_X, red],
      [ASM_Y, blue],
      [SHARED, red],
    ]);
    assert.deepEqual(out.get(SHARED), red, 'named explicitly last, so red wins outright');
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
