/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tiered content matching (the #1891 follow-up).
 *
 * A real model is mostly *repeated* components. Bucketing the unpaired
 * entities by (`ifcType`, `dataHash`) alone therefore pairs only the unique
 * minority: three data-identical doors at three different places all land in
 * one bucket and nothing pairs. These tests cover the refinement inside a
 * bucket — by world geometry hash first, then the leftover 1:1 — plus the
 * capability abstention. Position-based pairing of an N:M leftover lives in
 * content-match-position.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { buildComponentFingerprints } from './fingerprint.js';
import type { EntityAabb, EntityFingerprint } from './types.js';

function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  const entity: EntityFingerprint<number> = {
    key,
    ifcType: opts.ifcType ?? 'IfcDoor',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    ref: opts.ref ?? 0,
  };
  if (opts.components) entity.components = opts.components;
  if (opts.aabb) entity.aabb = opts.aabb;
  return entity;
}

/** A 1x1x1 box centred on (x, y, z), optionally scaled per axis. */
function box(
  [x, y, z]: [number, number, number],
  size: [number, number, number] = [1, 1, 1],
): EntityAabb {
  return {
    min: [x - size[0] / 2, y - size[1] / 2, z - size[2] / 2],
    max: [x + size[0] / 2, y + size[1] / 2, z + size[2] / 2],
  };
}

/** Three data-identical doors at three unmoved positions, all re-GUIDed. */
const door = (key: string, geometryHash: string): EntityFingerprint<number> =>
  fp(key, { ifcType: 'IfcDoor', dataHash: 'same-content-hash', geometryHash });

describe('regression #1891: repeated identical components after a re-export', () => {
  it('pairs three re-GUIDed unmoved doors one-for-one instead of reporting one ambiguous group', () => {
    // The probe that motivated this work asserted the opposite: one
    // `ambiguous` group, added=3, deleted=3, nothing paired. Geometry was not
    // part of the bucket key, so the three doors could not be told apart.
    const base = [door('OLD-A', 'g@x=0'), door('OLD-B', 'g@x=1'), door('OLD-C', 'g@x=2')];
    const head = [door('NEW-A', 'g@x=0'), door('NEW-B', 'g@x=1'), door('NEW-C', 'g@x=2')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.entries).toEqual([]);

    const matches = diff.contentMatches ?? [];
    expect(matches.map((m) => m.kind)).toEqual(['renamed', 'renamed', 'renamed']);
    // Each door pairs with the door standing in its own place, not with an
    // arbitrary member of the group.
    expect(matches.map((m) => [m.base[0].key, m.head[0].key]).sort()).toEqual([
      ['OLD-A', 'NEW-A'],
      ['OLD-B', 'NEW-B'],
      ['OLD-C', 'NEW-C'],
    ]);
  });

  it('a single door still pairs as renamed (the 1:1 case that already worked)', () => {
    const diff = diffModels([door('OLD-A', 'g@x=0')], [door('NEW-A', 'g@x=0')], {
      matchUnpairedByContent: true,
    });

    expect(diff.counts.added).toBe(0);
    expect(diff.counts.deleted).toBe(0);
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['renamed']);
  });

  it('pairs the doors that stayed and reports the one that moved, in one bucket', () => {
    const base = [door('OLD-A', 'g@x=0'), door('OLD-B', 'g@x=1')];
    const head = [door('NEW-A', 'g@x=0'), door('NEW-B', 'g@x=9')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    const matches = diff.contentMatches ?? [];
    expect(matches).toHaveLength(2);
    const renamed = matches.find((m) => m.kind === 'renamed');
    const moved = matches.find((m) => m.kind === 'moved');
    expect(renamed?.base[0].key).toBe('OLD-A');
    expect(moved?.base[0].key).toBe('OLD-B');
    expect(moved?.head[0].key).toBe('NEW-B');
    // No bounding boxes were supplied, so there is no distance to report.
    expect(moved?.distance).toBeUndefined();
  });

  it('leaves the group ambiguous under scope: data, where the caller opted out of geometry', () => {
    const base = [door('OLD-A', 'g@x=0'), door('OLD-B', 'g@x=1')];
    const head = [door('NEW-A', 'g@x=0'), door('NEW-B', 'g@x=1')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true, scope: 'data' });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['ambiguous']);
  });
});

describe('content matching — geometry-hash sub-buckets (tier 1)', () => {
  it('retires an N:N sub-bucket as one renamed match carrying every member', () => {
    // Both the data hash and the world geometry hash agree, twice over, on
    // both sides. Every bijection is then identical in every field the engine
    // can see, so the group retires without fabricating a specific pairing.
    const base = [door('b1', 'g@same'), door('b2', 'g@same')];
    const head = [door('h1', 'g@same'), door('h2', 'g@same')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.entries).toEqual([]);
    expect(diff.contentMatches).toHaveLength(1);
    const match = diff.contentMatches?.[0];
    expect(match?.kind).toBe('renamed');
    expect(match?.base.map((e) => e.key)).toEqual(['b1', 'b2']);
    expect(match?.head.map((e) => e.key)).toEqual(['h1', 'h2']);
  });

  it('does not retire an N:N sub-bucket whose component sub-hashes disagree', () => {
    const componentsA = buildComponentFingerprints({
      ifcType: 'IfcDoor',
      name: 'Door',
      propertySets: [{ name: 'Pset_DoorCommon', properties: [{ name: 'Reference', value: 'A' }] }],
    });
    const componentsB = buildComponentFingerprints({
      ifcType: 'IfcDoor',
      name: 'Door',
      propertySets: [{ name: 'Pset_DoorCommon', properties: [{ name: 'Reference', value: 'B' }] }],
    });
    const base = [
      fp('b1', { dataHash: 'd1', geometryHash: 'g', components: componentsA }),
      fp('b2', { dataHash: 'd1', geometryHash: 'g', components: componentsA }),
    ];
    const head = [
      fp('h1', { dataHash: 'd1', geometryHash: 'g', components: componentsB }),
      fp('h2', { dataHash: 'd1', geometryHash: 'g', components: componentsB }),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // The guard proves the shared data hash was a collision: nothing retires.
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['ambiguous']);
  });

  it('does not treat undefined geometry hashes as agreement', () => {
    // `undefined` matching `undefined` is vacuous, not evidence, so these do
    // not get sub-bucketed into a 2:2 "renamed" group.
    //
    const base = [fp('b1', { dataHash: 'd1' }), fp('b2', { dataHash: 'd1' })];
    const head = [fp('h1', { dataHash: 'd1' }), fp('h2', { dataHash: 'd1' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['ambiguous']);
  });

  it('still declines an undefined pair inside a model that does carry geometry', () => {
    // The case above has NO geometry anywhere, which is parity rather than a
    // capability mismatch (`baseHasGeometry === headHasGeometry` is true when
    // both are false), so tier 1 does run there. This variant makes that
    // independent of the abstention entirely: the `anchor` pair carries a
    // geometry hash on both sides, so `useGeometry` is unambiguously true and
    // tier 1 must decline the undefined pair on its own merits.
    //
    // Added after a review of #1992 argued the case above was unreachable. It
    // is reachable — a mutation removing tier 1's undefined routing reds both
    // — but the two fixtures pin the behaviour for different reasons and a
    // realistic model looks like this one.
    const anchor = (key: string) => fp(key, { dataHash: 'anchor', geometryHash: 'g@anchor' });
    const base = [anchor('same'), fp('b1', { dataHash: 'd1' }), fp('b2', { dataHash: 'd1' })];
    const head = [anchor('same'), fp('h1', { dataHash: 'd1' }), fp('h2', { dataHash: 'd1' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 1 });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['ambiguous']);
  });

  it('retires nothing from an uneven sub-bucket and reports it as duplicated', () => {
    const base = [door('b1', 'g@same')];
    const head = [door('h1', 'g@same'), door('h2', 'g@same')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['duplicated']);
  });

  it('keeps a unique element that genuinely moved pairable (geometry is not in the outer bucket key)', () => {
    // The reason the tiers live inside the bucket: with geometry in the outer
    // key these two would never meet and a real move would revert to
    // add+delete noise.
    const diff = diffModels([door('old', 'g@before')], [door('new', 'g@after')], {
      matchUnpairedByContent: true,
    });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['moved']);
  });
});

describe('content matching — moved vs reshaped from the bounding box (tier 2)', () => {
  const movedPair = (baseAabb: EntityAabb, headAabb: EntityAabb) => ({
    base: [fp('old', { dataHash: 'd1', geometryHash: 'g1', aabb: baseAabb })],
    head: [fp('new', { dataHash: 'd1', geometryHash: 'g2', aabb: headAabb })],
  });

  it('reports a same-size box whose centre travelled as moved, with the distance', () => {
    const { base, head } = movedPair(box([0, 0, 0]), box([3, 4, 0]));

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
    expect(diff.contentMatches?.[0]?.distance).toBeCloseTo(5, 10);
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });

  it('reports a box that changed size as reshaped, not moved', () => {
    const { base, head } = movedPair(box([0, 0, 0]), box([3, 0, 0], [2, 1, 1]));

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('reshaped');
    expect(diff.contentMatches?.[0]?.distance).toBeCloseTo(3, 10);
  });

  it('reports an unmoved box whose geometry hash changed as reshaped with distance 0', () => {
    // Same size, same centre, different hash: a re-tessellation looks exactly
    // like a reshape confined to the interior of the box, and the AABB cannot
    // separate them.
    const { base, head } = movedPair(box([0, 0, 0]), box([0, 0, 0]));

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('reshaped');
    expect(diff.contentMatches?.[0]?.distance).toBe(0);
  });

  it('treats a sub-tolerance centre shift as no move at all (#1197)', () => {
    const { base, head } = movedPair(box([0, 0, 0]), box([1e-4, 0, 0]));

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('reshaped');
    expect(diff.contentMatches?.[0]?.distance).toBe(0);
  });

  it('honours a caller-supplied moveTolerance', () => {
    const { base, head } = movedPair(box([0, 0, 0]), box([0.5, 0, 0]));

    const strict = diffModels(base, head, { matchUnpairedByContent: true });
    expect(strict.contentMatches?.[0]?.kind).toBe('moved');
    expect(strict.contentMatches?.[0]?.distance).toBeCloseTo(0.5, 10);

    const loose = diffModels(base, head, { matchUnpairedByContent: true, moveTolerance: 1 });
    expect(loose.contentMatches?.[0]?.kind).toBe('reshaped');
    expect(loose.contentMatches?.[0]?.distance).toBe(0);
  });

  it('honours a caller-supplied reshapeTolerance', () => {
    const { base, head } = movedPair(box([0, 0, 0]), box([3, 0, 0], [1.05, 1, 1]));

    const strict = diffModels(base, head, { matchUnpairedByContent: true });
    expect(strict.contentMatches?.[0]?.kind).toBe('reshaped');

    const loose = diffModels(base, head, { matchUnpairedByContent: true, reshapeTolerance: 0.1 });
    expect(loose.contentMatches?.[0]?.kind).toBe('moved');
  });

  it('falls back to a bare moved when only one side carries a box', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 'g1', aabb: box([0, 0, 0]) })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: 'g2' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
    expect(diff.contentMatches?.[0]?.distance).toBeUndefined();
  });

  it('ignores a box with a non-finite coordinate rather than propagating NaN', () => {
    const broken: EntityAabb = { min: [0, 0, Number.NaN], max: [1, 1, 1] };
    const { base, head } = movedPair(box([0, 0, 0]), broken);

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
    expect(diff.contentMatches?.[0]?.distance).toBeUndefined();
  });
});

describe('content matching — abstains when only one side was fingerprinted with geometry', () => {
  it('reports renamed, not moved, when the head revision carries no geometry hashes at all', () => {
    // A capability difference between two fingerprinting runs (hashing on in
    // one build, off in the other) is not a model change. Without the
    // abstention every one-sided `undefined` reads as "geometry differs" and
    // the whole model reports as moved.
    const base = [
      fp('kept', { dataHash: 'd0', geometryHash: 'g0' }),
      fp('old', { dataHash: 'd1', geometryHash: 'g1' }),
    ];
    const head = [fp('kept', { dataHash: 'd0' }), fp('new', { dataHash: 'd1' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
    expect(diff.contentMatches?.[0]?.distance).toBeUndefined();
  });

  it('abstains in the other direction too (base has no hashes, head does)', () => {
    const base = [fp('old', { dataHash: 'd1' })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: 'g1' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
  });

  it('still reports moved when both sides carry hashes and only one entity lacks one', () => {
    // Not a capability difference: this revision really did lose the
    // entity's geometry, so the abstention must not swallow it.
    const base = [
      fp('other', { dataHash: 'd0', geometryHash: 'g0' }),
      fp('old', { dataHash: 'd1', geometryHash: 'g1' }),
    ];
    const head = [fp('other', { dataHash: 'd0', geometryHash: 'g0' }), fp('new', { dataHash: 'd1' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
  });
});

describe('diffModels — geometry hash representation is the caller\'s contract', () => {
  // Raised by a CodeRabbit CLI review of this branch. Equality is
  // `String(a) === String(b)`, which is fine for the documented pairing
  // (a wasm `bigint` and its own decimal string) but means a differently
  // *rendered* value is a different fingerprint. Pinned rather than
  // "fixed": canonicalizing numeric-looking strings would collide an
  // opaque caller token with an unrelated bigint. Tier 1 sub-buckets on
  // `String(hash)`, so a mismatch costs the pair its `renamed` and drops it
  // to the residue — where it can still pair, as the spurious geometry
  // change the second test pins. Worth a test either way.
  it('pairs a bigint hash with its own decimal string form', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 42n })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: '42' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
  });

  it('treats a differently-rendered hash as a different fingerprint, not an equal one', () => {
    const base = [fp('old', { dataHash: 'd1', geometryHash: 42n })];
    const head = [fp('new', { dataHash: 'd1', geometryHash: '0x2a' })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // Same content bucket, different geometry sub-bucket → tier 1 cannot
    // pair them, so they fall to tier 2 and read as a geometry change.
    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
  });
});

describe('diffModels — a one-sided leftover is not dressed up as a group', () => {
  // Raised Medium by Cursor Bugbot on #1989: when a tier resolves every
  // candidate on one side, the driver `continue`s and emits no group, where
  // the pre-tier pass would have reported the whole bucket as `duplicated`.
  //
  // Declined deliberately, and pinned here so the change is visible rather
  // than accidental. A `ContentMatch` whose `base` is empty asserts that some
  // head entities are ambiguous against *nothing*, which `groupKind(0, n)`
  // would label `ambiguous` — a strictly less honest description of an entity
  // that is simply added. The leftover stays in `entries` as `added` and
  // carries its own `dataHash`, so a caller that wants the grouping can still
  // reconstruct it; nothing is lost that was not recoverable.
  //
  // What the caller gains instead is the definite answer tier 1 found.
  //
  // Mutation note, recorded because it is not the tidy result: TWO redundant
  // guards suppress the one-sided group (`content-match.ts`, once right after
  // tier 1 and again after the positional pass). Mutating either ALONE leaves
  // the other catching it, so neither line is individually pinned; mutating
  // both together reds the first test below. The redundancy is defence in
  // depth rather than dead code, and this is what it costs to verify.
  it('reports the exact pair as renamed and leaves the odd one out as a plain add', () => {
    const base = [door('b1', 'g@A')];
    const head = [door('h1', 'g@A'), door('h2', 'g@B')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // Pre-tier this bucket reported one `duplicated` group of 1 base + 2 head
    // and retired nothing. Now b1 -> h1 is settled and h2 is what it is.
    expect(diff.contentMatches?.map((m) => m.kind)).toEqual(['renamed']);
    expect(diff.contentMatches?.[0]?.base[0]?.key).toBe('b1');
    expect(diff.contentMatches?.[0]?.head[0]?.key).toBe('h1');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.entries.filter((e) => e.state === 'added').map((e) => e.key)).toEqual(['h2']);
  });

  it('still reports the group when BOTH sides have leftovers', () => {
    const base = [door('b1', 'g@A'), door('b2', 'g@X')];
    const head = [door('h1', 'g@A'), door('h2', 'g@Y')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.map((m) => m.kind).sort()).toEqual(['moved', 'renamed']);
  });
});
