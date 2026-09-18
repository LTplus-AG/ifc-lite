/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Class families for the split/merge candidate buckets (issue #4955): a wall
 * republished as `IfcBuildingElementPart` layers or `IfcWallStandardCase`
 * pieces used to be invisible, because candidates were bucketed by exact
 * `ifcType` and the pieces never met the whole.
 */

import { describe, expect, it } from 'vitest';
import { classFamilyResolver, familyOf } from './class-families.js';
import { diffModels } from './diff.js';
import type { EntityAabb, EntityFingerprint, ModelDiff } from './types.js';

type Ref = number;

function box(min: [number, number, number], max: [number, number, number]): EntityAabb {
  return { min, max };
}

function entity(init: {
  key: string;
  aabb: EntityAabb;
  volume?: number;
  ifcType?: string;
}): EntityFingerprint<Ref> {
  const fingerprint: EntityFingerprint<Ref> = {
    key: init.key,
    ifcType: init.ifcType ?? 'IfcWall',
    dataHash: init.key,
    geometryHash: `g@${init.key}`,
    aabb: init.aabb,
    ref: 0,
  };
  if (init.volume !== undefined) fingerprint.volume = init.volume;
  return fingerprint;
}

/** A 6 x 0.3 x 3 m wall (5.4 m³) and its three 100 mm layers as parts. */
const wall = () => entity({ key: 'W', aabb: box([0, 0, 0], [6, 0.3, 3]), volume: 5.4 });
const layers = (ifcType: string) =>
  [0, 1, 2].map((i) =>
    entity({
      key: `L${i}`,
      ifcType,
      aabb: box([0, i * 0.1, 0], [6, (i + 1) * 0.1, 3]),
      volume: 1.8,
    }),
  );

function run(
  base: EntityFingerprint<Ref>[],
  head: EntityFingerprint<Ref>[],
  options: Record<string, unknown> = {},
): ModelDiff<Ref> {
  return diffModels(base, head, { matchUnpairedByContent: true, detectSplitMerge: true, ...options });
}

describe('familyOf', () => {
  it('maps the schema subtypes and the part class onto the wall family, case-insensitively', () => {
    expect(familyOf('IfcWall')).toBe('IFCWALL');
    expect(familyOf('IFCWALLSTANDARDCASE')).toBe('IFCWALL');
    expect(familyOf('IfcBuildingElementPart')).toBe('IFCWALL');
    expect(familyOf(' ifcSlabElementedCase ')).toBe('IFCSLAB');
  });

  it('leaves an unlisted class as its own family', () => {
    expect(familyOf('IfcCovering')).toBe('IFCCOVERING');
    expect(familyOf('IfcCovering')).not.toBe(familyOf('IfcWall'));
  });

  it('a custom table wins over the default, and a class listed twice keeps its first row', () => {
    const resolve = classFamilyResolver([
      ['IfcWall', 'IfcCovering'],
      ['IfcSlab', 'IfcCovering'],
    ]);
    expect(resolve('IfcCovering')).toBe('IFCWALL');
    // Not in the custom table: no longer related to walls.
    expect(resolve('IfcBuildingElementPart')).toBe('IFCBUILDINGELEMENTPART');
  });

  it('skips malformed rows from an untyped caller, and falls back on a non-array table', () => {
    const resolve = classFamilyResolver([[], ['', '  '], ['IfcWall', 42 as unknown as string]]);
    expect(resolve('IfcWall')).toBe('IFCWALL');
    for (const bad of [null, {}, 'IfcWall', 7]) {
      const fallback = classFamilyResolver(bad as unknown as readonly (readonly string[])[]);
      expect(fallback('IfcBuildingElementPart')).toBe('IFCWALL');
    }
  });
});

describe('split/merge across a class family (issue #4955)', () => {
  it('claims a wall republished as three IfcBuildingElementPart layers as a verified, cross-class split', () => {
    const diff = run([wall()], layers('IfcBuildingElementPart'));
    expect(diff.splitMerges).toHaveLength(1);
    const claim = diff.splitMerges![0];
    expect(claim.kind).toBe('split');
    expect(claim.confidence).toBe('verified');
    expect(claim.whole.key).toBe('W');
    expect(claim.pieces.map((p) => p.key).sort()).toEqual(['L0', 'L1', 'L2']);
    expect(claim.crossClass).toBe(true);
    // A claim never retires anything.
    expect(diff.counts).toEqual({ added: 3, modified: 0, deleted: 1, unchanged: 0 });
  });

  it('claims the same split when the pieces are IfcWallStandardCase', () => {
    const diff = run([wall()], layers('IfcWallStandardCase'));
    expect(diff.splitMerges).toHaveLength(1);
    expect(diff.splitMerges![0].crossClass).toBe(true);
  });

  it('does not flag crossClass on a same-class split, whatever the adapter casing', () => {
    const diff = run([wall()], layers('IfcWall'));
    expect(diff.splitMerges).toHaveLength(1);
    expect(diff.splitMerges![0].crossClass).toBeUndefined();
    const upper = run([wall()], layers('IFCWALL'));
    expect(upper.splitMerges).toHaveLength(1);
    expect(upper.splitMerges![0].crossClass).toBeUndefined();
  });

  it('still refuses a split across families (a wall becoming coverings)', () => {
    const diff = run([wall()], layers('IfcCovering'));
    expect(diff.splitMerges).toEqual([]);
  });

  it('an empty classFamilies table restores exact-class bucketing', () => {
    const diff = run([wall()], layers('IfcBuildingElementPart'), { classFamilies: [] });
    expect(diff.splitMerges).toEqual([]);
  });

  it('a custom table can widen a family', () => {
    const diff = run([wall()], layers('IfcCovering'), {
      classFamilies: [['IfcWall', 'IfcCovering']],
    });
    expect(diff.splitMerges).toHaveLength(1);
    expect(diff.splitMerges![0].crossClass).toBe(true);
  });

  it('claims the merge direction across classes too', () => {
    const diff = run(layers('IfcBuildingElementPart'), [wall()]);
    expect(diff.splitMerges).toHaveLength(1);
    expect(diff.splitMerges![0]).toMatchObject({ kind: 'merge', crossClass: true });
  });
});
