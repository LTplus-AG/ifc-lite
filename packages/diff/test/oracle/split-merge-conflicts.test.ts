/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The global conflict pass over candidate claims (issue #1891).
 *
 * Two properties, and the second is the interesting one: the order is
 * reproducible on any machine, and the lexicographic key that makes it
 * reproducible is never allowed to DECIDE anything.
 */

import { describe, expect, it } from 'vitest';
import { resolveClaimConflicts } from './split-merge.js';
import type { EntityFingerprint, SplitMergeClaim, SplitMergeConfidence } from './types.js';

type Ref = number;

/** Entity objects are shared by reference between claims — participation is
 *  decided by object identity, so two claims "share a piece" only when they
 *  hold the same object. */
const pool = new Map<string, EntityFingerprint<Ref>>();
function ent(key: string): EntityFingerprint<Ref> {
  const existing = pool.get(key);
  if (existing) return existing;
  const created: EntityFingerprint<Ref> = {
    key,
    ifcType: 'IfcWall',
    dataHash: key,
    ref: 0,
  };
  pool.set(key, created);
  return created;
}

function claim(
  confidence: SplitMergeConfidence,
  whole: string,
  pieces: string[],
  residual?: number,
): SplitMergeClaim<Ref> {
  const built: SplitMergeClaim<Ref> = {
    kind: 'split',
    confidence,
    whole: ent(whole),
    pieces: pieces.map(ent),
  };
  if (residual !== undefined) built.volumeResidual = residual;
  return built;
}

const keys = (accepted: SplitMergeClaim<Ref>[]): string[] => accepted.map((c) => c.whole.key);

describe('resolveClaimConflicts', () => {
  it('keeps claims that share no entity', () => {
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b']),
      claim('verified', 'W2', ['c', 'd']),
    ]);
    expect(keys(accepted).sort()).toEqual(['W1', 'W2']);
  });

  it('gives a contested piece to the stronger evidence profile', () => {
    const accepted = resolveClaimConflicts([
      claim('extent', 'W2', ['a', 'b']),
      claim('verified', 'W1', ['a', 'c']),
    ]);
    expect(keys(accepted)).toEqual(['W1']);
  });

  it('ranks displaced above extent — it measured the geometry, extent never did', () => {
    const accepted = resolveClaimConflicts([
      claim('extent', 'W2', ['a', 'b']),
      claim('displaced', 'W1', ['a', 'c'], 0),
    ]);
    expect(keys(accepted)).toEqual(['W1']);
  });

  it('prefers the claim that explains more of the residue at equal confidence', () => {
    const accepted = resolveClaimConflicts([
      claim('verified', 'W2', ['a', 'b'], 0),
      claim('verified', 'W1', ['a', 'b', 'c'], 0),
    ]);
    expect(keys(accepted)).toEqual(['W1']);
  });

  it('prefers the closer volume agreement at equal confidence and piece count', () => {
    const accepted = resolveClaimConflicts([
      claim('verified', 'W2', ['a', 'b'], 0.02),
      claim('verified', 'W1', ['a', 'c'], 0.001),
    ]);
    expect(keys(accepted)).toEqual(['W1']);
  });

  it('DROPS BOTH when only the alphabet separates them', () => {
    // The rule this pass exists for. Two claims identical in every field the
    // engine can weigh, contesting the same piece: the tiebreak makes the
    // ordering reproducible, it does not adjudicate. Picking the earlier key
    // would dress a coin flip up as an answer (#1923).
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
    ]);
    expect(accepted).toEqual([]);
  });

  it('drops both even when a third, unrelated claim is present', () => {
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('verified', 'W3', ['d', 'e'], 0.01),
    ]);
    expect(keys(accepted)).toEqual(['W3']);
  });

  it('DROPS ALL THREE when three equal claims contest one piece', () => {
    // "Drops both" does not generalise pairwise. The second claim retires the
    // first and frees everything it held; without the dispute being remembered,
    // the third finds the gap empty and is accepted — so the alphabet decides
    // after all, two steps later.
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('verified', 'W3', ['a', 'd'], 0.01),
    ]);
    expect(accepted).toEqual([]);
  });

  it('DROPS ALL FOUR when four equal claims contest one piece', () => {
    // Four, not just three: a fix that only re-pairs the leftover would work for
    // odd counts and fail silently for even ones, and a three-claim test alone
    // could not tell the two apart.
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('verified', 'W3', ['a', 'd'], 0.01),
      claim('verified', 'W4', ['a', 'e'], 0.01),
    ]);
    expect(accepted).toEqual([]);
  });

  it('refuses an equal claim over material the retired incumbent had held', () => {
    // The gap a tie opens is the WHOLE participant set of both sides, not only
    // the entity they collided on: retiring the incumbent frees `b` as well, and
    // an equal-rank claim over `b` would be inheriting an abstention rather than
    // winning an argument.
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('verified', 'W3', ['b', 'd'], 0.01),
    ]);
    expect(accepted).toEqual([]);
  });

  it('refuses an equal claim over material the tie’s LOSER wanted, too', () => {
    // Symmetry. `W2` never became the incumbent, so nothing it held was
    // "freed" — but it was one of the two the engine could not tell apart, and
    // handing `c` to the next equal claim decides "W2 loses c" on the strength
    // of W2 having lost a tie about `a`. That is the alphabet again, one hop
    // removed. Both sides of a tie leave their material unadjudicated.
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('verified', 'W3', ['c', 'e'], 0.01),
    ]);
    expect(accepted).toEqual([]);
  });

  it('still accepts an equal claim that touches none of the contested material', () => {
    // The abstention is scoped to the dispute, not global: a tie at rank R must
    // not silence every other claim at rank R in the model.
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('verified', 'W3', ['x', 'y'], 0.01),
    ]);
    expect(keys(accepted)).toEqual(['W3']);
  });

  it('lets a strictly weaker claim stand after a tie retires both', () => {
    // Documented behaviour, not an oversight. The weaker claim is not the tie —
    // it is a different proposition on its own, lesser evidence, and refusing
    // it would punish it for a dispute it was not part of.
    const accepted = resolveClaimConflicts([
      claim('verified', 'W1', ['a', 'b'], 0.01),
      claim('verified', 'W2', ['a', 'c'], 0.01),
      claim('extent', 'W3', ['b', 'c']),
    ]);
    expect(keys(accepted)).toEqual(['W3']);
  });

  it('is order-independent, and orders its output by evidence', () => {
    const candidates = [
      claim('extent', 'W3', ['e', 'f']),
      claim('verified', 'W1', ['a', 'b'], 0),
      claim('displaced', 'W2', ['c', 'd'], 0),
    ];
    const forward = keys(resolveClaimConflicts(candidates));
    const reversed = keys(resolveClaimConflicts([...candidates].reverse()));
    expect(forward).toEqual(['W1', 'W2', 'W3']);
    expect(reversed).toEqual(forward);
  });

  it('treats the WHOLE as a participant too, not only the pieces', () => {
    // An added element can be a split-piece of one whole and the merge-whole
    // over others, which is exactly why the conflict pass is global.
    // Ranked apart on piece count so the conflict is DECIDED rather than tied:
    // if the whole were not a participant, both would simply be accepted.
    const asWhole = claim('verified', 'a', ['x', 'y'], 0);
    const asPiece = claim('verified', 'W1', ['a', 'b', 'c'], 0);
    expect(keys(resolveClaimConflicts([asWhole, asPiece]))).toEqual(['W1']);
  });
});
