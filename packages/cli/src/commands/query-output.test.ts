/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `query-output.ts` backs every non-error path of `ifc-lite query` — count,
 * sum, avg/min/max, group-by, and entity listing — and had no test file.
 * Each test below is paired with a concrete mutation that left the package's
 * 310 tests green; see the doc comment on each `it` for the mutation it kills.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  outputCount,
  outputSum,
  outputAggregation,
  outputGroupBy,
  outputEntities,
} from './query-output.js';

interface FakeEntity {
  ref: number;
  name?: string;
  type?: string;
  globalId?: string;
}

function fakeBim(opts: {
  quantities?: Record<number, Array<{ name: string; quantities: Array<{ name: string; value: unknown }> }>>;
  properties?: Record<number, Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>>;
  storeys?: Record<number, { name: string } | undefined>;
  materials?: Record<number, { materials?: unknown[]; name?: string } | undefined>;
} = {}) {
  return {
    quantities: (ref: number) => opts.quantities?.[ref] ?? [],
    properties: (ref: number) => opts.properties?.[ref] ?? [],
    storey: (ref: number) => opts.storeys?.[ref],
    materials: (ref: number) => opts.materials?.[ref],
  };
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { chunks, spy };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { chunks, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('outputCount', () => {
  /**
   * Kills swapping `if (jsonOutput)` for `if (!jsonOutput)` in outputCount:
   * with the branches inverted, `--json` prints the bare number to stdout
   * and plain mode prints `{"count":...}`.
   */
  it('routes json vs. plain output to the matching branch', () => {
    const json = captureStdout();
    outputCount(5, true);
    json.spy.mockRestore();
    expect(JSON.parse(json.chunks.join(''))).toEqual({ count: 5 });

    const plain = captureStdout();
    outputCount(5, false);
    plain.spy.mockRestore();
    expect(plain.chunks.join('')).toBe('5\n');
  });
});

describe('outputSum', () => {
  const bim = fakeBim({
    quantities: {
      1: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', value: 10 }] }],
      2: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', value: 5 }] }],
    },
  });

  /**
   * Kills flipping `matched === 0` to `matched !== 0` in the not-found guard:
   * inverted, a quantity that IS present on every entity takes the "not
   * found" error branch instead of reporting the real total.
   */
  it('sums a present quantity instead of reporting it missing', () => {
    const out = captureStdout();
    outputSum([{ ref: 1 }, { ref: 2 }] as FakeEntity[], 'NetVolume', bim, false);
    out.spy.mockRestore();
    expect(out.chunks.join('')).toBe('15\n');
  });

  it('reports zero and an error when the quantity is absent everywhere', () => {
    const out = captureStdout();
    const err = captureStderr();
    outputSum([{ ref: 1 }] as FakeEntity[], 'NoSuchQty', bim, false);
    out.spy.mockRestore();
    err.spy.mockRestore();
    expect(out.chunks.join('')).toBe('0\n');
    expect(err.chunks.join('')).toContain('not found');
  });

  /**
   * Kills changing the area/surface similarity check from `||` to `&&` in
   * the disambiguation warning: with `&&`, a quantity named "GrossSideArea"
   * (contains "area" but not "surface") stops being flagged as a possible
   * mix-up for a `--sum Area` query, silently dropping the warning.
   */
  it('warns about a similarly-named quantity that was not summed', () => {
    const bimWithAmbiguity = fakeBim({
      quantities: {
        1: [{
          name: 'Qto_WallBaseQuantities',
          quantities: [
            { name: 'Area', value: 4 },
            { name: 'GrossSideArea', value: 12 },
          ],
        }],
      },
    });
    const json = captureStdout();
    outputSum([{ ref: 1 }] as FakeEntity[], 'Area', bimWithAmbiguity, true);
    json.spy.mockRestore();
    const parsed = JSON.parse(json.chunks.join(''));
    expect(parsed.alternatives.map((a: { name: string }) => a.name)).toContain(
      'Qto_WallBaseQuantities.GrossSideArea',
    );
  });
});

describe('outputAggregation', () => {
  const bim = fakeBim({
    quantities: {
      1: [{ name: 'Qto', quantities: [{ name: 'Area', value: 30 }] }],
      2: [{ name: 'Qto', quantities: [{ name: 'Area', value: 10 }] }],
      3: [{ name: 'Qto', quantities: [{ name: 'Area', value: 20 }] }],
    },
  });

  /**
   * Kills flipping `matched === 0` to `matched !== 0`: entities with real
   * values would report "not found" instead of an average.
   */
  it('computes an average over present values', () => {
    const out = captureStdout();
    outputAggregation([{ ref: 1 }, { ref: 2 }, { ref: 3 }] as FakeEntity[], 'Area', 'avg', bim, false);
    out.spy.mockRestore();
    expect(out.chunks.join('')).toBe('20\n');
  });

  /**
   * Kills flipping `val < minVal` to `val > minVal` in the min/max tracking
   * loop: with the comparison flipped, `--min` reports the maximum value
   * (and its entity) instead of the minimum.
   */
  it('reports the correct min value and its owning entity', () => {
    const json = captureStdout();
    outputAggregation([{ ref: 1, name: 'A' }, { ref: 2, name: 'B' }, { ref: 3, name: 'C' }] as FakeEntity[], 'Area', 'min', bim, true);
    json.spy.mockRestore();
    const parsed = JSON.parse(json.chunks.join(''));
    expect(parsed.min).toBe(10);
    expect(parsed.entity.Name).toBe('B');
  });

  it('reports zero-match error for a missing quantity', () => {
    const err = captureStderr();
    outputAggregation([{ ref: 1 }] as FakeEntity[], 'Missing', 'max', bim, false);
    err.spy.mockRestore();
    expect(err.chunks.join('')).toContain('not found');
  });
});

describe('outputGroupBy', () => {
  const entities: FakeEntity[] = [
    { ref: 1, type: 'IfcWall' },
    { ref: 2, type: 'IfcWall' },
    { ref: 3, type: 'IfcDoor' },
  ];
  const bim = fakeBim();

  /**
   * Kills flipping the validation guard from
   * `!VALID_GROUP_BY_KEYS.includes(k) && !k.includes('.')` to `||`: every
   * plain `--group-by type` call (a valid built-in key with no dot) then
   * fails validation and calls fatal() instead of grouping.
   */
  it('accepts a plain built-in grouping key without calling fatal', () => {
    const out = captureStdout();
    expect(() => outputGroupBy(entities, 'type', undefined, bim, false)).not.toThrow();
    out.spy.mockRestore();
    expect(out.chunks.join('')).toContain('IfcWall: 2');
  });

  /**
   * Kills swapping `[psetName, propName] = groupByKey.split('.', 2)` to
   * `[propName, psetName]`: a dotted `--group-by Pset.Prop` would then look
   * up a pset named after the property and never find a match.
   */
  it('groups by a dotted PsetName.PropName path in the correct order', () => {
    const propBim = fakeBim({
      properties: {
        1: [{ name: 'Pset_WallCommon', properties: [{ name: 'Reference', value: 'R1' }] }],
        2: [{ name: 'Pset_WallCommon', properties: [{ name: 'Reference', value: 'R2' }] }],
      },
    });
    const json = captureStdout();
    outputGroupBy([{ ref: 1 }, { ref: 2 }] as FakeEntity[], 'Pset_WallCommon.Reference', undefined, propBim, true);
    json.spy.mockRestore();
    const parsed = JSON.parse(json.chunks.join(''));
    expect(Object.keys(parsed).sort()).toEqual(['R1', 'R2']);
  });

  /**
   * Kills flipping the non-json sort comparator from `b[1].length -
   * a[1].length` (descending by group size) to ascending: the largest group
   * (IfcWall, 2 entities) would print after the smaller one instead of first.
   */
  it('lists groups largest-first in table mode', () => {
    const out = captureStdout();
    outputGroupBy(entities, 'type', undefined, bim, false);
    out.spy.mockRestore();
    const text = out.chunks.join('');
    expect(text.indexOf('IfcWall: 2')).toBeLessThan(text.indexOf('IfcDoor: 1'));
  });

  /**
   * Kills widening `entries.slice(0, groupLimit)` to `slice(0, groupLimit +
   * 1)` in the json branch: `--limit 1 --group-by type --json` would then
   * return 2 groups instead of the requested 1.
   */
  it('limits the number of groups, not entities, under --limit', () => {
    const json = captureStdout();
    outputGroupBy(entities, 'type', undefined, bim, true, 1);
    json.spy.mockRestore();
    const parsed = JSON.parse(json.chunks.join(''));
    expect(Object.keys(parsed)).toHaveLength(1);
  });
});

describe('outputEntities', () => {
  const entities: FakeEntity[] = [
    { ref: 1, type: 'IfcWall', name: 'Wall-1', globalId: 'G1' },
    { ref: 2, type: 'IfcDoor', name: 'Door-1', globalId: 'G2' },
  ];
  const bim = fakeBim();

  /**
   * Kills swapping the table row mapping from `[e.type, e.name, e.globalId]`
   * to `[e.name, e.type, e.globalId]`: the header still reads "Type | Name |
   * GlobalId" but the printed cells would be transposed under the wrong
   * column.
   */
  it('prints table columns in Type, Name, GlobalId order', () => {
    const out = captureStdout();
    outputEntities(entities, [], bim, false);
    out.spy.mockRestore();
    const lines = out.chunks.join('').split('\n');
    // Header row establishes the column order this asserts against.
    expect(lines[0]).toMatch(/Type.*Name.*GlobalId/);
    const wallRow = lines.find((l) => l.includes('Wall-1'))!;
    expect(wallRow.indexOf('IfcWall')).toBeLessThan(wallRow.indexOf('Wall-1'));
  });

  /**
   * Kills dropping `showQuantities` from the `needsDetail` OR-chain: without
   * it, `--quantities` (with no `--json`) would fall through to the plain
   * table branch instead of emitting per-entity quantity detail.
   */
  it('switches to detailed JSON-shaped output when --quantities is set, even without --json', () => {
    const quantityBim = fakeBim({
      quantities: { 1: [{ name: 'Qto', quantities: [{ name: 'Area', value: 5 }] }] },
    });
    const out = captureStdout();
    outputEntities([{ ref: 1, type: 'IfcWall', name: 'Wall-1', globalId: 'G1' }] as FakeEntity[], ['--quantities'], quantityBim, false);
    out.spy.mockRestore();
    const parsed = JSON.parse(out.chunks.join(''));
    expect(parsed[0].quantities).toEqual([{ name: 'Qto', quantities: [{ name: 'Area', value: 5 }] }]);
  });
});
