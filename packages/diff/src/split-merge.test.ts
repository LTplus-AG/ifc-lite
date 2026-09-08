/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The split/merge detector end to end, through `diffModels` (issue #1891).
 *
 * The property under test throughout is NOT "finds as many splits as possible".
 * It is "claims only what the evidence supports, and abstains loudly
 * otherwise" — so at least half of these cases assert that nothing is reported.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { identityMapFromContentMatches } from './identity-map.js';
import { detectSplitMerge } from './split-merge.js';
import type { DiffEntry, EntityAabb, EntityFingerprint, ModelDiff } from './types.js';

type Ref = number;

/** An axis-aligned box from two corners. */
function box(
  min: [number, number, number],
  max: [number, number, number],
): EntityAabb {
  return { min, max };
}

interface EntityInit {
  key: string;
  aabb: EntityAabb;
  volume?: number;
  ifcType?: string;
  dataHash?: string;
}

function entity(init: EntityInit): EntityFingerprint<Ref> {
  const fingerprint: EntityFingerprint<Ref> = {
    key: init.key,
    ifcType: init.ifcType ?? 'IfcWall',
    dataHash: init.dataHash ?? init.key,
    // Every entity carries a hash so the capability abstention never fires by
    // accident; the hashes are all distinct so the content pass's tier 1
    // resolves nothing and everything reaches the residue.
    geometryHash: `g@${init.key}`,
    aabb: init.aabb,
    ref: 0,
  };
  if (init.volume !== undefined) fingerprint.volume = init.volume;
  return fingerprint;
}

/**
 * The reference fixture: a 6 x 0.2 x 3 m wall, and the same wall cut into three
 * 2 m segments. Volumes are the honest box volumes (3.6 m³ = 3 x 1.2 m³), so a
 * residual in a test is a residual the test put there.
 */
const WHOLE_BOX = box([0, 0, 0], [6, 0.2, 3]);
const WHOLE_VOLUME = 3.6;

function segment(index: number, volume: number | undefined, keyPrefix = 'p'): EntityFingerprint<Ref> {
  return entity({
    key: `${keyPrefix}${index}`,
    dataHash: 'segment',
    aabb: box([index * 2, 0, 0], [(index + 1) * 2, 0.2, 3]),
    ...(volume === undefined ? {} : { volume }),
  });
}

/** The three segments, each with the given volume. */
function segments(volumes: (number | undefined)[], keyPrefix = 'p'): EntityFingerprint<Ref>[] {
  return volumes.map((volume, index) => segment(index, volume, keyPrefix));
}

const wholeWall = (): EntityFingerprint<Ref> =>
  entity({ key: 'W', dataHash: 'whole', aabb: WHOLE_BOX, volume: WHOLE_VOLUME });

/** The same wall with no PROVED volume — a material-layered wall, whose slices
 *  are open bands by construction, so the kernel refuses to measure it.
 *  A separate function rather than `wholeWall(undefined)`, because a JS default
 *  parameter fires on `undefined` and would have handed back the measured wall
 *  while the test read as if it had not. */
const unmeasuredWall = (): EntityFingerprint<Ref> =>
  entity({ key: 'W', dataHash: 'whole', aabb: WHOLE_BOX });

/** Run the detector with everything it needs switched on. */
function run(
  base: EntityFingerprint<Ref>[],
  head: EntityFingerprint<Ref>[],
  options: Record<string, unknown> = {},
): ModelDiff<Ref> {
  return diffModels(base, head, {
    matchUnpairedByContent: true,
    detectSplitMerge: true,
    ...options,
  });
}

const claims = (diff: ModelDiff<Ref>) => diff.splitMerges ?? [];

describe('split/merge — the verified profile', () => {
  it('claims a wall cut into three segments whose volumes conserve', () => {
    const diff = run([wholeWall()], segments([1.2, 1.2, 1.2]));

    expect(claims(diff)).toHaveLength(1);
    const claim = claims(diff)[0];
    expect(claim.kind).toBe('split');
    expect(claim.confidence).toBe('verified');
    expect(claim.whole.key).toBe('W');
    expect(claim.pieces.map((p) => p.key)).toEqual(['p0', 'p1', 'p2']);
    expect(claim.wholeVolume).toBe(WHOLE_VOLUME);
    expect(claim.piecesVolume).toBeCloseTo(3.6, 10);
    expect(claim.volumeResidual).toBeCloseTo(0, 10);
    expect(claim.excluded).toBeUndefined();
  });

  it('accepts material lost to joints inside the 3% band', () => {
    // 3 x 1.176 = 3.528, which is -2% of 3.6: the couplings and grout a real
    // split loses. 1% would have refused this, which is why the default is 3%.
    const diff = run([wholeWall()], segments([1.176, 1.176, 1.176]));
    expect(claims(diff)).toHaveLength(1);
    expect(claims(diff)[0].confidence).toBe('verified');
    expect(claims(diff)[0].volumeResidual).toBeCloseTo(-0.02, 6);
  });

  it('is symmetric: the same geometry as a merge', () => {
    const diff = run(segments([1.2, 1.2, 1.2]), [wholeWall()]);

    expect(claims(diff)).toHaveLength(1);
    const claim = claims(diff)[0];
    expect(claim.kind).toBe('merge');
    expect(claim.confidence).toBe('verified');
    // `whole` names the single entity whichever direction the claim runs.
    expect(claim.whole.key).toBe('W');
    expect(claim.pieces).toHaveLength(3);
  });
});

describe('split/merge — volume as a refutation', () => {
  it('refuses a complete set that misses the band, and does NOT fall back to extents', () => {
    // 3 x 1.14 = 3.42, -5%. The boxes cover the whole wall perfectly, so an
    // implementation that treated a failed volume test as "try the weaker
    // evidence" would report an `extent` claim here. Failed volume evidence is
    // a REFUTATION, and the extent tier exists only for evidence ABSENCE.
    const diff = run([wholeWall()], segments([1.14, 1.14, 1.14]));
    expect(claims(diff)).toEqual([]);
  });

  it('refutes on a PARTIAL sum, because an unknown can only add', () => {
    // One segment's volume is unproved. What is known already overruns the
    // whole by 8%, and no value the unknown could take brings it back down.
    const diff = run([wholeWall()], segments([2.5, 1.4, undefined]));
    expect(claims(diff)).toEqual([]);
  });

  it('refuses a whole that lost most of its material', () => {
    // Undershoot is refuted just as hard as overshoot: two thirds of the wall
    // is unaccounted for, so whatever happened, it was not a split.
    const diff = run([wholeWall()], segments([0.4, 0.4, 0.4]));
    expect(claims(diff)).toEqual([]);
  });
});

describe('split/merge — the extent profile', () => {
  it('claims on interval coverage when a volume is missing and nothing refuted', () => {
    const diff = run([wholeWall()], segments([1.2, undefined, 1.2]));

    expect(claims(diff)).toHaveLength(1);
    const claim = claims(diff)[0];
    expect(claim.confidence).toBe('extent');
    // No volume numbers on an extent claim: reporting a partial sum as
    // `piecesVolume` would read as the pieces' volume, which it is not.
    expect(claim.wholeVolume).toBeUndefined();
    expect(claim.piecesVolume).toBeUndefined();
    expect(claim.volumeResidual).toBeUndefined();
  });

  it('fires when the WHOLE has no volume, even with every piece measured', () => {
    // A material-layered wall is exactly this case: open bands by construction,
    // so the kernel proves nothing about the parent while the new single-solid
    // segments each measure fine.
    const diff = run([unmeasuredWall()], segments([1.2, 1.2, 1.2]));
    expect(claims(diff).map((c) => c.confidence)).toEqual(['extent']);
  });

  it('refuses when the pieces leave a gap wider than the padding', () => {
    const withHole = [segment(0, undefined), segment(2, undefined)];
    const diff = run([unmeasuredWall()], withHole);
    expect(claims(diff)).toEqual([]);
  });
});

describe('split/merge — the one-interloper exception', () => {
  /** A small same-class element sitting inside the wall's box. */
  const interloper = (key: string, volume: number, x = 0.5): EntityFingerprint<Ref> =>
    entity({ key, dataHash: 'other', aabb: box([x, 0, 0], [x + 0.4, 0.2, 0.5]), volume });

  it('excludes the single element whose own volume explains the overshoot', () => {
    const diff = run([wholeWall()], [...segments([1.2, 1.2, 1.2]), interloper('x', 0.5)]);

    expect(claims(diff)).toHaveLength(1);
    const claim = claims(diff)[0];
    expect(claim.confidence).toBe('verified');
    expect(claim.pieces.map((p) => p.key)).toEqual(['p0', 'p1', 'p2']);
    // Reported, not silently dropped: "that thing is something else" is a
    // statement about a real entity a reviewer may disagree with.
    expect(claim.excluded?.key).toBe('x');
  });

  it('abstains when SEVERAL pieces each explain the overshoot', () => {
    // Three equal segments overshooting a 2.4 m³ whole by exactly one segment:
    // dropping any one of them lands the sum on the nose, and nothing says
    // which. Two candidates carry no information about which is the interloper,
    // and this is exactly where a subset search would start guessing (#1923).
    const short = entity({ key: 'W', dataHash: 'whole', aabb: WHOLE_BOX, volume: 2.4 });
    const diff = run([short], segments([1.2, 1.2, 1.2]));
    expect(claims(diff)).toEqual([]);
  });

  it('abstains when no single element explains the overshoot', () => {
    // Every piece is oversized rather than one being foreign, so there is
    // nothing to solve for. Note an interloper cannot express this case: adding
    // exactly one always makes the overshoot equal to its own volume.
    const diff = run([wholeWall()], segments([1.5, 1.5, 1.5]));
    expect(claims(diff)).toEqual([]);
  });

  it('abstains when TWO same-class interlopers pollute the box', () => {
    // The named limitation. With two of them the overshoot is their SUM, and no
    // single piece explains a sum — which is the cap doing its job, not a gap.
    const diff = run([wholeWall()], [
      ...segments([1.2, 1.2, 1.2]),
      interloper('x', 0.5, 0.5),
      interloper('y', 0.5, 1.5),
    ]);
    expect(claims(diff)).toEqual([]);
  });

  it('does not repair an UNDERSHOOT by dropping a piece', () => {
    // Removing a piece can only make missing material worse, and there is no
    // "one absent piece" to solve for — an absent piece is not in the set.
    const diff = run([wholeWall()], segments([1.0, 1.0, 1.0]));
    expect(claims(diff)).toEqual([]);
  });
});

describe('split/merge — the displaced profile', () => {
  /** The same three segments, translated 30 m along X. */
  function movedSegments(volumes: (number | undefined)[]): EntityFingerprint<Ref>[] {
    return volumes.map((volume, index) =>
      entity({
        key: `m${index}`,
        dataHash: 'segment',
        aabb: box([30 + index * 2, 0, 0], [30 + (index + 1) * 2, 0.2, 3]),
        ...(volume === undefined ? {} : { volume }),
      }),
    );
  }

  it('claims a split that also moved out of the old extent', () => {
    const diff = run([wholeWall()], movedSegments([1.2, 1.2, 1.2]));

    expect(claims(diff)).toHaveLength(1);
    const claim = claims(diff)[0];
    expect(claim.confidence).toBe('displaced');
    expect(claim.pieces.map((p) => p.key)).toEqual(['m0', 'm1', 'm2']);
    expect(claim.volumeResidual).toBeCloseTo(0, 10);
  });

  it('tolerates a 90° turn, because the extents are compared sorted', () => {
    const turned = [0, 1, 2].map((index) =>
      entity({
        key: `t${index}`,
        dataHash: 'segment',
        aabb: box([30, index * 2, 0], [30.2, (index + 1) * 2, 3]),
        volume: 1.2,
      }),
    );
    const diff = run([wholeWall()], turned);
    expect(claims(diff).map((c) => c.confidence)).toEqual(['displaced']);
  });

  it('requires COMPLETE volumes — extents alone are not evidence of identity', () => {
    // Without volume, a moved cluster matched on class and congruent extents
    // false-positives across a repetitive building. There is no extent fallback
    // in this lane at all.
    const diff = run([wholeWall()], movedSegments([1.2, undefined, 1.2]));
    expect(claims(diff)).toEqual([]);
  });

  it('abstains between two congruent clusters in a repetitive building', () => {
    // The named limitation, pinned: two identical walls deleted, two identical
    // clusters added, and nothing distinguishes which became which.
    const secondWall = entity({
      key: 'W2',
      dataHash: 'whole',
      aabb: box([10, 0, 0], [16, 0.2, 3]),
      volume: WHOLE_VOLUME,
    });
    const secondCluster = [0, 1, 2].map((index) =>
      entity({
        key: `n${index}`,
        dataHash: 'segment',
        aabb: box([50 + index * 2, 0, 0], [50 + (index + 1) * 2, 0.2, 3]),
        volume: 1.2,
      }),
    );
    const diff = run([wholeWall(), secondWall], [...movedSegments([1.2, 1.2, 1.2]), ...secondCluster]);
    expect(claims(diff)).toEqual([]);
  });

  it('refuses a cluster that never left the whole, so a refuted set cannot come back', () => {
    // THE back door the subset refusal has to close. A bottom band, a left
    // column and a top band tile the wall's outline and touch each other, so
    // they form one cluster whose union box IS the wall and whose volumes sum
    // to it exactly. Two further strays sit in the hollow middle, touching
    // nothing, and they are what makes lane 1 refuse the full containment set
    // (the overshoot is 1.1 m³ and no single piece explains it).
    //
    // Lane 2 then sees a sub-cluster of a REFUTED set that sums right — the
    // subset search arriving by another route, wearing a `displaced` label it
    // has not earned, because those pieces never moved anywhere.
    const outline = [
      entity({ key: 'a0', dataHash: 'segment', aabb: box([0, 0, 0], [6, 0.2, 0.5]), volume: 1.5 }),
      entity({ key: 'a1', dataHash: 'segment', aabb: box([0, 0, 0.5], [0.5, 0.2, 2.5]), volume: 0.6 }),
      entity({ key: 'a2', dataHash: 'segment', aabb: box([0, 0, 2.5], [6, 0.2, 3]), volume: 1.5 }),
    ];
    const strays = [
      entity({ key: 'q', dataHash: 'segment', aabb: box([3, 0, 1.2], [3.5, 0.2, 1.7]), volume: 0.7 }),
      entity({ key: 'r', dataHash: 'segment', aabb: box([5, 0, 1.2], [5.4, 0.2, 1.6]), volume: 0.4 }),
    ];
    const diff = run([wholeWall()], [...outline, ...strays]);
    expect(claims(diff)).toEqual([]);
  });
});

describe('split/merge — what it runs on, and what it never touches', () => {
  it('is purely additive: entries, byKey and counts are untouched', () => {
    const base = [wholeWall()];
    const head = segments([1.2, 1.2, 1.2]);
    const withDetector = run(base, head);
    const without = diffModels(base, head, { matchUnpairedByContent: true });

    expect(withDetector.counts).toEqual(without.counts);
    expect(withDetector.counts).toEqual({ added: 3, modified: 0, deleted: 1, unchanged: 0 });
    expect(withDetector.entries.map((e) => e.key).sort()).toEqual(
      without.entries.map((e) => e.key).sort(),
    );
    expect([...withDetector.byKey.keys()].sort()).toEqual([...without.byKey.keys()].sort());
    expect(without.splitMerges).toBeUndefined();
  });

  it('never mints an identity-map entry from a claim', () => {
    // Identity is not a relation that survives being split. The claims are not
    // ContentMatches, so there is nothing for the identity map to read.
    const diff = run([wholeWall()], segments([1.2, 1.2, 1.2]));
    expect(claims(diff)).toHaveLength(1);
    const entries = identityMapFromContentMatches(diff.contentMatches);
    const keys = new Set(entries.flatMap((e) => [e.base, e.here]));
    for (const participant of ['W', 'p0', 'p1', 'p2']) {
      expect(keys.has(participant)).toBe(false);
    }
  });

  it('runs on the RESIDUE: a re-GUIDed wall is retired before it can be a whole', () => {
    // The load-bearing ordering. Here the wall is renamed, not split, and two
    // genuinely-new IfcWalls happen to sit inside its box with volumes summing
    // to its own. Run before content matching, the wall would be `deleted`, the
    // renamed copy would be the one-interloper exclusion, and the two new walls
    // would be reported as its pieces — a fabricated split out of a rename.
    const renamed = entity({ key: 'W-new', dataHash: 'whole', aabb: WHOLE_BOX, volume: WHOLE_VOLUME });
    // Same geometry hash as the base wall, so tier 1 retires the pair.
    renamed.geometryHash = 'g@W';
    const newFixtures = [
      entity({ key: 'f0', dataHash: 'fixture', aabb: box([0, 0, 0], [3, 0.2, 3]), volume: 1.8 }),
      entity({ key: 'f1', dataHash: 'fixture', aabb: box([3, 0, 0], [6, 0.2, 3]), volume: 1.8 }),
    ];

    const diff = run([wholeWall()], [renamed, ...newFixtures]);

    expect((diff.contentMatches ?? []).map((m) => m.kind)).toContain('renamed');
    expect(claims(diff)).toEqual([]);
  });

  it('does not see a split across classes', () => {
    // Named limitation, pinned so it is a decision rather than a surprise:
    // candidates are generated per ifcType, so an IfcWall becoming three
    // IfcWallStandardCases is invisible.
    const reclassed = segments([1.2, 1.2, 1.2]).map((piece) => ({
      ...piece,
      ifcType: 'IfcWallStandardCase',
    }));
    expect(claims(run([wholeWall()], reclassed))).toEqual([]);
  });

  it('ignores an entity with no usable box', () => {
    const boxless = segments([1.2, 1.2, 1.2]).map((piece) => {
      const copy = { ...piece };
      delete copy.aabb;
      return copy;
    });
    expect(claims(run([wholeWall()], boxless))).toEqual([]);
  });

  it('refuses a 1:1 relation — that is the content pass’s job, not this one', () => {
    const single = [segment(0, WHOLE_VOLUME)];
    expect(claims(run([wholeWall()], single))).toEqual([]);
  });
});

describe('split/merge — containment is what binds lane 1', () => {
  it('does not sweep in a same-class element just BEYOND the whole', () => {
    // Two segments inside account for only two thirds of the wall. A third
    // segment sitting 200 mm past its end would complete the sum exactly —
    // which is precisely why membership is decided by where the geometry is,
    // not by what makes the arithmetic work.
    //
    // 200 mm, not 100 m: the spatial grid never even offers a distant element,
    // so a fixture placed far away would pass whether the containment test
    // existed or not. This one is close enough to be a candidate and outside
    // enough to be refused, which is the only place the test can bite.
    const inside = [segment(0, 1.2), segment(1, 1.2)];
    const beyond = entity({
      key: 'beyond',
      dataHash: 'segment',
      aabb: box([6.2, 0, 0], [8.2, 0.2, 3]),
      volume: 1.2,
    });
    expect(claims(run([wholeWall()], [...inside, beyond]))).toEqual([]);
  });

  it('gives a piece to the whole it sits in, not to a signature match elsewhere', () => {
    // Lane 2 only ever sees what lane 1 did not take. Here the wall the
    // segments sit in has no proved volume (a material-layered wall), so lane 1
    // can only reach `extent` — while a second, measured wall 30 m away is a
    // perfect signature match for the same three segments. Offering them to
    // lane 2 as well would let the `displaced` claim outrank the `extent` one
    // and report the segments as having MOVED out of a wall they are inside.
    const elsewhere = entity({
      key: 'W2',
      dataHash: 'whole',
      aabb: box([30, 0, 0], [36, 0.2, 3]),
      volume: WHOLE_VOLUME,
    });
    const diff = run([unmeasuredWall(), elsewhere], segments([1.2, 1.2, 1.2]));
    expect(claims(diff)).toHaveLength(1);
    expect(claims(diff)[0].whole.key).toBe('W');
    expect(claims(diff)[0].confidence).toBe('extent');
  });
});

describe('split/merge — lane 2 needs uniqueness in BOTH directions', () => {
  /** Three 2 m segments tiling a 6 x 0.2 x 3 footprint at `x`. */
  function cluster(keyPrefix: string, x: number, volume: number): EntityFingerprint<Ref>[] {
    return [0, 1, 2].map((index) =>
      entity({
        key: `${keyPrefix}${index}`,
        dataHash: 'segment',
        aabb: box([x + index * 2, 0, 0], [x + (index + 1) * 2, 0.2, 3]),
        volume,
      }),
    );
  }

  it('abstains when ONE cluster matches two wholes', () => {
    const second = entity({
      key: 'W2',
      dataHash: 'whole',
      aabb: box([10, 0, 0], [16, 0.2, 3]),
      volume: WHOLE_VOLUME,
    });
    expect(claims(run([wholeWall(), second], cluster('m', 30, 1.2)))).toEqual([]);
  });

  it('abstains when ONE whole matches two clusters', () => {
    // The two clusters differ in piece count, so the conflict pass would have
    // had a winner to pick — the abstention has to happen before it, in the
    // lane, on the grounds that the whole cannot have become both.
    const four = [0, 1, 2, 3].map((index) =>
      entity({
        key: `n${index}`,
        dataHash: 'segment',
        aabb: box([50 + index * 1.5, 0, 0], [50 + (index + 1) * 1.5, 0.2, 3]),
        volume: 0.9,
      }),
    );
    expect(claims(run([wholeWall()], [...cluster('m', 30, 1.2), ...four]))).toEqual([]);
  });

  it('refuses a cluster whose known volumes sum right but are incomplete', () => {
    // The known volumes land exactly on the whole, which is the trap: a sum
    // missing a term is not a sum, and the unmeasured piece could be anything.
    const partial = [
      entity({ key: 'm0', dataHash: 'segment', aabb: box([30, 0, 0], [32, 0.2, 3]), volume: 1.8 }),
      entity({ key: 'm1', dataHash: 'segment', aabb: box([32, 0, 0], [34, 0.2, 3]), volume: 1.8 }),
      entity({ key: 'm2', dataHash: 'segment', aabb: box([34, 0, 0], [36, 0.2, 3]) }),
    ];
    expect(claims(run([wholeWall()], partial))).toEqual([]);
  });

  it('refuses a cluster whose volume matches but whose shape does not', () => {
    // Three 1 m cubes 30 m away summing to exactly the wall's volume. Volume
    // alone is a weak signature — a great many things in a building have the
    // volume of a wall — so the extents have to agree as well.
    const blob = [0, 1, 2].map((index) =>
      entity({
        key: `c${index}`,
        dataHash: 'segment',
        aabb: box([30 + index, 0, 0], [31 + index, 1, 1]),
        volume: 1.2,
      }),
    );
    expect(claims(run([wholeWall()], blob))).toEqual([]);
  });
});

describe('split/merge — the option and its abstentions', () => {
  it('is PRESENT and empty when the stage ran and found nothing', () => {
    // The other half of the contract: emptiness has to remain reachable, or
    // presence would only ever mean "found something" and a caller could not
    // tell an abstention from a clean model.
    const diff = run([wholeWall()], [segment(0, 1.2)]);
    expect(diff.splitMerges).toEqual([]);
  });

  it('reports nothing at all when the option is off', () => {
    const diff = diffModels([wholeWall()], segments([1.2, 1.2, 1.2]), {
      matchUnpairedByContent: true,
    });
    expect(diff.splitMerges).toBeUndefined();
  });

  it('is inert without content matching, because it runs on that pass’s residue', () => {
    const diff = diffModels([wholeWall()], segments([1.2, 1.2, 1.2]), {
      detectSplitMerge: true,
    });
    expect(diff.splitMerges).toBeUndefined();
  });

  it('inherits the scope:data abstention — there is no non-geometric evidence', () => {
    // ABSENT, not empty. The field's presence is the record that the stage ran;
    // `[]` would tell a caller the detector executed and found nothing, which is
    // a different statement about a run that never looked.
    const diff = run([wholeWall()], segments([1.2, 1.2, 1.2]), { scope: 'data' });
    expect(diff.splitMerges).toBeUndefined();
    expect('splitMerges' in diff).toBe(false);
  });

  it('inherits the mixed-capability abstention', () => {
    // One revision fingerprinted with geometry hashing on, the other with it
    // off, is a difference between two fingerprinting runs, not a split.
    const hashless = segments([1.2, 1.2, 1.2]).map((piece) => {
      const copy = { ...piece };
      delete copy.geometryHash;
      return copy;
    });
    const diff = run([wholeWall()], hashless);
    expect(diff.splitMerges).toBeUndefined();
    expect('splitMerges' in diff).toBe(false);
  });
});

describe('split/merge — the knobs', () => {
  it('honours a tighter volume tolerance', () => {
    const head = segments([1.176, 1.176, 1.176]); // -2%
    expect(claims(run([wholeWall()], head))).toHaveLength(1);
    expect(claims(run([wholeWall()], head, { splitVolumeTolerance: 0.01 }))).toEqual([]);
  });

  it('drops rather than truncates a candidate over maxSplitPieces', () => {
    // A perf bail, never a semantic rule. The three segments already account
    // for the whole wall, so an implementation that TRUNCATED the containment
    // set to the cap would find the first three summing perfectly and report a
    // claim — over a set it had silently edited. Reporting the first 3 of 4 is
    // a claim nobody made.
    const extra = entity({
      key: 'z',
      dataHash: 'segment',
      aabb: box([0.5, 0, 0], [0.9, 0.2, 0.5]),
      volume: 0.9,
    });
    const head = [...segments([1.2, 1.2, 1.2]), extra];
    expect(claims(run([wholeWall()], head, { maxSplitPieces: 3 }))).toEqual([]);
  });

  it('refuses to let an unachievable piece cap silence the whole stage', () => {
    // `0` and `1` pass a plain "finite and >= 0" coercion, and BOTH lanes then
    // reject every candidate they could ever build, because a candidate has at
    // least two pieces by definition. The stage would report nothing, with no
    // error anywhere — the same silent vanish the NaN guard exists to prevent,
    // arriving through a different door.
    //
    // A split into fewer than two pieces is not a split, so these are not tight
    // caps but unachievable ones, and they fall back to the default.
    for (const maxSplitPieces of [0, 1, 1.9, -4]) {
      const diff = run([wholeWall()], segments([1.2, 1.2, 1.2]), { maxSplitPieces });
      expect(claims(diff), `maxSplitPieces: ${maxSplitPieces}`).toHaveLength(1);
      expect(claims(diff)[0].pieces).toHaveLength(3);
    }
  });

  it('floors a fractional cap rather than refusing it', () => {
    // A cap of 2.5 pieces IS a cap of 2 pieces — counts are integers, so
    // nothing is invented by flooring and nothing is lost. Falling back to the
    // default here would ignore a cap the caller can perfectly well have meant.
    expect(claims(run([wholeWall()], segments([1.2, 1.2, 1.2]), { maxSplitPieces: 2.5 }))).toEqual(
      [],
    );
    // ...and the floored value is really 2, not 3: a two-piece candidate still
    // passes, so the cap is being applied rather than the whole option ignored.
    const halves = [segment(0, 1.8), segment(1, 1.8)];
    halves[1] = entity({
      key: 'p1',
      dataHash: 'segment',
      aabb: box([2, 0, 0], [6, 0.2, 3]),
      volume: 1.8,
    });
    expect(claims(run([wholeWall()], halves, { maxSplitPieces: 2.5 }))).toHaveLength(1);
  });

  it('coerces a NaN knob to its default instead of poisoning every comparison', () => {
    // An untyped caller can pass anything, and a NaN tolerance makes every
    // comparison false — the claim would vanish with no error anywhere.
    const diff = run([wholeWall()], segments([1.2, 1.2, 1.2]), {
      splitVolumeTolerance: Number.NaN,
      splitPaddingMin: Number.NaN,
      splitPaddingRatio: Number.NaN,
      maxSplitPieces: Number.NaN,
    });
    expect(claims(diff)).toHaveLength(1);
    expect(claims(diff)[0].confidence).toBe('verified');
  });

  it('is order-independent', () => {
    const base = [wholeWall()];
    const head = segments([1.2, 1.2, 1.2]);
    const forward = claims(run(base, head));
    const reversed = claims(run(base, [...head].reverse()));
    expect(reversed.map((c) => c.pieces.map((p) => p.key))).toEqual(
      forward.map((c) => c.pieces.map((p) => p.key)),
    );
  });

  it('orders pieces that REPEAT a GlobalId by data hash, not by arrival order', () => {
    // `sortPieces`'s SECOND key, which the test above cannot reach: with all
    // keys distinct the first key already decides every comparison, so the
    // tiebreak is free to be missing. A file that repeats a GlobalId still has
    // two distinct entities, and without the tiebreak their relative order in
    // the claim is whatever order the caller enumerated them in — two runs
    // over the same model emit two different claims.
    //
    // Driven through `detectSplitMerge` directly because `diffModels` cannot
    // reach it: `indexByKey` keeps only the first occurrence of a repeated
    // key, so the second entity never becomes a candidate.
    const whole = wholeWall();
    const piece = (index: number, key: string, dataHash: string): EntityFingerprint<Ref> => ({
      ...segment(index, 1.2),
      key,
      dataHash,
    });
    // Arrival order deliberately violates the required order on the tiebreak.
    const pieces = [
      piece(0, 'dup', 'h-zzz'),
      piece(1, 'dup', 'h-aaa'),
      piece(2, 'other', 'h-mmm'),
    ];
    const entries: DiffEntry<Ref>[] = [
      { key: whole.key, state: 'deleted', changeKinds: [], base: whole },
      ...pieces.map(
        (p): DiffEntry<Ref> => ({ key: p.key, state: 'added', changeKinds: [], head: p }),
      ),
    ];

    const found = detectSplitMerge(entries, true, {});

    expect(found).toHaveLength(1);
    expect(found?.[0].confidence).toBe('verified');
    expect(found?.[0].pieces.map((p) => [p.key, p.dataHash])).toEqual([
      ['dup', 'h-aaa'],
      ['dup', 'h-zzz'],
      ['other', 'h-mmm'],
    ]);
  });
});
