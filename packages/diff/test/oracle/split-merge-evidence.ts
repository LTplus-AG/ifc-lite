/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The volume evidence a split/merge claim rests on (issue #1891), and the one
 * bounded exception to it.
 *
 * **Volume is asymmetric, and that is the whole design.** As PROOF it demands
 * completeness: the whole and every single piece must carry a trusted volume,
 * because a sum missing one term is not a sum. As REFUTATION it works
 * partially: if the volumes we already know overrun the whole beyond tolerance,
 * no unknown can bring the total back down, and the claim is dead regardless of
 * what we cannot see. Roughly a third of a real model's elements carry no
 * volume, so a rule that needed completeness in both directions would abstain
 * on most of the model in both directions.
 *
 * **Subsets are refused.** The detector tests the FULL containment set or the
 * FULL cluster, never an enumeration of its subsets — and the 3% tolerance is
 * exactly the reason. A tolerance widens the target band, so on a set of any
 * size several different subsets qualify, and a non-unique answer is an
 * abstention in this codebase (see `mutual-nearest.ts`, and #1923, a shipped
 * `?? candidates[0]` bug of precisely that shape). The one exception below
 * solves for a UNIQUE explanation rather than searching for a qualifying one.
 */

/** A volume the engine will act on: finite and strictly positive (see
 *  `EntityFingerprint.volume` — absent, zero and negative all mean "no"). */
export function usableVolume(volume: number | undefined): number | undefined {
  return typeof volume === 'number' && Number.isFinite(volume) && volume > 0 ? volume : undefined;
}

/** What the volumes had to say about one candidate set. */
export interface VolumeVerdict {
  /**
   * - `confirmed` — every participant carried a volume and they agree.
   * - `refuted`   — what is known already disagrees; no claim, at any confidence.
   * - `unknown`   — something is missing and nothing known contradicts it.
   */
  kind: 'confirmed' | 'refuted' | 'unknown';
  /** Whether every participant carried a usable volume. */
  complete: boolean;
  wholeVolume?: number;
  /** Sum over the pieces that HAD a volume (the whole sum iff `complete`). */
  piecesVolume?: number;
  /** `(piecesVolume - wholeVolume) / wholeVolume`, only when both are known. */
  residual?: number;
}

/**
 * Weigh one whole against a set of pieces.
 *
 * `tolerance` is relative to the WHOLE's volume, not to the sum: the whole is
 * the thing being explained, and normalising by the sum would let a set that
 * overshoots badly quietly widen its own target.
 */
export function judgeVolumes(
  wholeVolumeRaw: number | undefined,
  pieceVolumesRaw: readonly (number | undefined)[],
  tolerance: number,
): VolumeVerdict {
  const wholeVolume = usableVolume(wholeVolumeRaw);
  let known = 0;
  let sum = 0;
  for (const raw of pieceVolumesRaw) {
    const volume = usableVolume(raw);
    if (volume === undefined) continue;
    known++;
    sum += volume;
  }
  const complete = wholeVolume !== undefined && known === pieceVolumesRaw.length;

  // No volume on the whole: nothing to weigh against, and the pieces alone
  // cannot refute anything either.
  if (wholeVolume === undefined) return { kind: 'unknown', complete: false };

  const band = tolerance * wholeVolume;

  // PARTIAL REFUTATION. Valid with unknowns present precisely because every
  // unknown can only ADD to the sum.
  if (sum > wholeVolume + band) {
    return {
      kind: 'refuted',
      complete,
      wholeVolume,
      piecesVolume: sum,
      residual: (sum - wholeVolume) / wholeVolume,
    };
  }

  if (!complete) return { kind: 'unknown', complete: false, wholeVolume };

  const residual = (sum - wholeVolume) / wholeVolume;
  return {
    kind: Math.abs(sum - wholeVolume) <= band ? 'confirmed' : 'refuted',
    complete: true,
    wholeVolume,
    piecesVolume: sum,
    residual,
  };
}

/**
 * THE ONE BOUNDED EXCEPTION to "test the full set".
 *
 * The common pollution in a real model is a single unrelated same-class element
 * sitting inside the parent's box — one radiator inside the wall's extent, one
 * short return wall inside a long one's. So: when a COMPLETE set overshoots the
 * whole by `r`, and **exactly one** piece's own volume is `r` within tolerance,
 * that piece is the explanation, and the rest of the set is the claim.
 *
 * This is solving for a unique explanation, not searching for a qualifying
 * subset. It is `O(k)`, it abstains when zero or two or more pieces explain `r`
 * (two candidates carry no information about which one is the interloper), and
 * it is capped at ONE exclusion — allowing two would put the combinatorics, and
 * with them the non-uniqueness the whole design refuses, straight back.
 *
 * Only an OVERSHOOT is repairable. An undershoot means material is missing, and
 * removing a piece can only make it worse; there is no "one absent piece" to
 * solve for, because an absent piece is not in the set.
 *
 * @returns the index of the excluded piece, or `undefined` to abstain.
 */
export function findSingleInterloper(
  wholeVolume: number,
  pieceVolumes: readonly number[],
  tolerance: number,
): number | undefined {
  const sum = pieceVolumes.reduce((total, volume) => total + volume, 0);
  const overshoot = sum - wholeVolume;
  const band = tolerance * wholeVolume;
  if (overshoot <= band) return undefined;
  // Excluding one piece must leave a real group, not a 1:1 pair the content
  // pass already had its chance at.
  if (pieceVolumes.length < 3) return undefined;

  let found: number | undefined;
  for (let index = 0; index < pieceVolumes.length; index++) {
    if (Math.abs(pieceVolumes[index] - overshoot) > band) continue;
    if (found !== undefined) return undefined; // two explanations is no explanation
    found = index;
  }
  return found;
}
