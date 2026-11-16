/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is the model's height reference plausible against the terrain next to it?
 *
 * Every per-element comparison is an absolute height against terrain, so a
 * wrong `OrthogonalHeight`, a wrong vertical datum or a wrong ground storey
 * shifts every result the same way: 500 m too low makes everything
 * `exposed`, a few metres too high makes elements look favourable. The hazard
 * map carries no heights, so the model's height reference CANNOT be verified
 * from it; the check can only catch errors large enough to contradict the
 * terrain. Two tests, one coarse and one fine:
 *
 * 1. Building level (refusal, {@link assessHeightReference}). With `Tmin` and
 *    `Tmax` the lowest and highest terrain sampled along the WHOLE footprint
 *    outline (and on the rings around every candidate), the ground storey
 *    level `g` must satisfy
 *
 *      Tmin - below <= g <= Tmax + above        (defaults below = 1.5 m, above = 2.5 m)
 *
 *    The outline samples make `Tmin..Tmax` span the slope on a hillside
 *    whichever side the candidates are on, so a walk-out basement (ground
 *    floor at the uphill grade) and a ground floor at the downhill grade both
 *    pass. `above = 2.5 m` allows a raised ground floor (Hochparterre, up to
 *    about 1.5 m) plus 1 m for terrain error; `below = 1.5 m` allows a ground
 *    floor sunk about 1 m below the lowest grade plus 0.5 m terrain error.
 *    Outside that the check refuses. On sloping ground this band is wide (it
 *    spans the whole slope), so it only catches gross errors.
 *
 * 2. Entry level (withholds favourable outcomes, {@link confirmEntries}). Each
 *    ground-storey door must sit at most `entryAbove` (default 2.5 m) above the
 *    terrain next to it (the median of its own ground samples). If any does
 *    not, or there is no such door to check, the height reference is
 *    UNCONFIRMED and no element anywhere gets a favourable outcome. If all do,
 *    the height of the highest ground-storey door above its adjacent terrain
 *    is an error the check cannot tell from a raised threshold: it is added to
 *    the clearance every favourable outcome needs (the "allowance"). A model
 *    placed too high by more than the allowance then needs every ground-storey
 *    door to really lie below its adjacent terrain, which is stated as the
 *    residual risk in every result.
 */

import { FloodCheckRefusal } from '../errors.js';
import type { CandidateFact, ModelFacts } from '../model/facts.js';
import type { LocalizedText, MapPoint } from '../types.js';

/** What the allowance is, in the one wording every text that states it uses (`allowance` is its value). */
export const ALLOWANCE_MEANING = {
  en: 'the height of the highest ground-storey door above its adjacent terrain',
  de: 'die Höhe der höchsten Erdgeschosstür über dem Gelände daneben',
} as const;

export interface PlausibilityOptions {
  /**
   * Metres the ground storey may lie below the lowest sampled terrain. Default
   * 1.5. A wider value turns a refusal into results, but then the height
   * reference counts as unconfirmed and no element gets a favourable outcome.
   */
  below?: number;
  /** Metres the ground storey may lie above the highest sampled terrain. Default 2.5. Wider: as for `below`. */
  above?: number;
  /**
   * Metres a ground-storey door may sit above the terrain next to it before
   * the height reference counts as unconfirmed. Default 2.5; may only be
   * lowered.
   */
  entryAbove?: number;
}

export const PLAUSIBILITY_DEFAULTS = { below: 1.5, above: 2.5, entryAbove: 2.5 } as const;

export interface HeightPlausibility {
  /** `within-widened-band`: outside the default band, inside the caller's wider one. */
  status: 'within-band' | 'within-widened-band' | 'not-checked-no-terrain';
  groundStoreyLevel: number;
  terrainMin: number | null;
  terrainMax: number | null;
  /** Terrain samples with a height (footprint outline plus candidate rings). */
  terrainSamples: number;
  below: number;
  above: number;
  /** The test with its numbers. */
  statement: string;
}

const f = (v: number) => v.toFixed(2);
const at = (p: MapPoint) => `E ${p.x.toFixed(1)}, N ${p.y.toFixed(1)}`;

function nonNegative(name: string, v: number): number {
  if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`heightPlausibility.${name} must be a finite number >= 0, got ${v}`);
  return v;
}

export function assessHeightReference(
  groundStoreyLevel: number,
  terrain: ReadonlyArray<{ point: MapPoint; height: number }>,
  options: PlausibilityOptions = {},
): HeightPlausibility {
  const below = nonNegative('below', options.below ?? PLAUSIBILITY_DEFAULTS.below);
  const above = nonNegative('above', options.above ?? PLAUSIBILITY_DEFAULTS.above);
  // Both band comparisons are false for NaN, which would pass the band and let the level confirm itself.
  if (!Number.isFinite(groundStoreyLevel)) {
    throw new FloodCheckRefusal(
      'georeference-implausible',
      `the ground storey level is ${groundStoreyLevel}, not a finite height, so the height reference cannot be tested against the terrain; no element results are reported. Check the storey elevation and the map conversion's OrthogonalHeight.`,
    );
  }
  if (terrain.length === 0) {
    return {
      status: 'not-checked-no-terrain',
      groundStoreyLevel,
      terrainMin: null,
      terrainMax: null,
      terrainSamples: 0,
      below,
      above,
      statement: 'not checked: no terrain height along the footprint outline or at any ground sample',
    };
  }
  let min = terrain[0];
  let max = terrain[0];
  for (const t of terrain) {
    if (t.height < min.height) min = t;
    if (t.height > max.height) max = t;
  }
  const g = groundStoreyLevel;
  const statement =
    `ground storey ${f(g)} m within [${f(min.height)} - ${below}, ${f(max.height)} + ${above}] m ` +
    `(lowest at ${at(min.point)} and highest at ${at(max.point)} of ${terrain.length} terrain samples along the footprint outline and next to the elements)`;
  if (g < min.height - below || g > max.height + above) {
    const side =
      g < min.height - below
        ? `${f(min.height - g)} m below the lowest terrain sampled around the building (${f(min.height)} m at ${at(min.point)}; ` +
          `${f(max.height)} m is the highest), more than the ${below} m allowed`
        : `${f(g - max.height)} m above the highest terrain sampled around the building (${f(max.height)} m at ${at(max.point)}; ` +
          `${f(min.height)} m is the lowest), more than the ${above} m allowed`;
    throw new FloodCheckRefusal(
      'georeference-implausible',
      `the ground storey level is ${f(g)} m, ${side}. The terrain was sampled ${terrain.length} times along the whole footprint ` +
        'outline and next to every element, so this is not a hillside sampled on one side only. It indicates a height-reference ' +
        "error in the model, not flood exposure; no element results are reported. Check, in this order: the map conversion's " +
        'OrthogonalHeight against the surveyed height of the project origin, the vertical datum (LN02 / LHN95), and which storey ' +
        'is taken as ground storey (pass groundStorey). If the building really sits so (for example in a pit), pass a wider ' +
        'heightPlausibility; results are then reported, but none as favourable.',
    );
  }
  const widened = g < min.height - PLAUSIBILITY_DEFAULTS.below || g > max.height + PLAUSIBILITY_DEFAULTS.above;
  return {
    status: widened ? 'within-widened-band' : 'within-band',
    groundStoreyLevel: g,
    terrainMin: min.height,
    terrainMax: max.height,
    terrainSamples: terrain.length,
    below,
    above,
    statement,
  };
}

/** One ground-storey door, compared with the terrain next to it. */
export interface EntryCheck {
  expressId: number;
  level: number;
  /** Median terrain height of the door's own ground samples; null when none has a height. */
  adjacentTerrain: number | null;
  /** `level - adjacentTerrain`. */
  heightAboveTerrain: number | null;
}

export interface HeightReference {
  /** `unconfirmed`: no element gets a favourable outcome. */
  status: 'confirmed' | 'unconfirmed';
  entryAbove: number;
  entries: EntryCheck[];
  /**
   * Extra clearance every favourable outcome needs: the height of the HIGHEST
   * ground-storey door above its adjacent terrain (0 when every one is at or
   * below), so a model placed too high by more than this would put every
   * ground-storey door below its terrain. Null when unconfirmed.
   */
  allowance: number | null;
  unconfirmedBecause: string[];
  /** What this run cannot detect about the height reference, with its numbers. */
  residualRisk: LocalizedText;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The entry-level test (module docs, test 2). `adjacent(i)` returns the terrain
 * heights at candidate `i`'s own ground samples; `extraReasons` are
 * building-level reasons that make the reference unconfirmed anyway (a widened
 * band, a widened plan extent).
 */
export function confirmEntries(
  facts: Pick<ModelFacts, 'candidates' | 'groundStorey'>,
  adjacent: (index: number) => number[],
  eligible: (c: CandidateFact, index: number) => boolean,
  band: HeightPlausibility,
  options: PlausibilityOptions = {},
  extraReasons: readonly string[] = [],
  /** The clearance margin; ground-storey doors further apart than this about where terrain is leave the reference unconfirmed. Null: 0.5 m. */
  margin: number | null = null,
): HeightReference {
  const entryAbove = nonNegative('entryAbove', options.entryAbove ?? PLAUSIBILITY_DEFAULTS.entryAbove);
  if (entryAbove > PLAUSIBILITY_DEFAULTS.entryAbove) {
    throw new RangeError(
      `heightPlausibility.entryAbove may only be lowered (default ${PLAUSIBILITY_DEFAULTS.entryAbove} m), got ${entryAbove}: ` +
        'a wider tolerance would let a model placed too high pass as a raised entrance',
    );
  }
  const reasons = [...extraReasons];
  if (band.status === 'not-checked-no-terrain') reasons.push('no terrain height was available around the building');
  if (band.status === 'within-widened-band') {
    reasons.push(`the ground storey lies outside the default height band and was accepted only by a widened heightPlausibility (${band.statement})`);
  }
  const entries: EntryCheck[] = [];
  const g = facts.groundStorey.expressId;
  // Only a ground storey the caller stated can confirm: one picked by the ±0.00 convention, the lowest storey or none may be
  // the basement, whose doors lie at the terrain of a sunken yard or below it (re-audit N2).
  if (facts.groundStorey.basis !== 'given') {
    reasons.push(`the ground storey was guessed (${facts.groundStorey.basis}), so its doors cannot confirm the height reference; pass groundStorey`);
  }
  if (g === null) {
    reasons.push('no ground storey is identified, so no ground-storey door can be checked against the terrain');
  } else {
    facts.candidates.forEach((c, i) => {
      if (c.category !== 'door' || c.storeyId !== g || !eligible(c, i)) return;
      if (!Number.isFinite(c.level)) {
        // A non-finite level compares false against every limit: it must not read as "not too high".
        reasons.push(`ground-storey door #${c.expressId} has no finite level (${c.level}), so it cannot confirm the height reference`);
        return;
      }
      const heights = adjacent(i);
      const t = heights.length > 0 ? median(heights) : null;
      entries.push({ expressId: c.expressId, level: c.level, adjacentTerrain: t, heightAboveTerrain: t === null ? null : c.level - t });
    });
    if (entries.length === 0) reasons.push('the ground storey has no door on the footprint outline to check the height reference against');
    // Doors of one storey should agree about their height above terrain; a sunken or raised one makes the reference ambiguous.
    const heights = entries.map((e) => e.heightAboveTerrain).filter((h): h is number => h !== null);
    const spread = heights.length > 1 ? Math.max(...heights) - Math.min(...heights) : 0;
    const limit = margin ?? 0.5;
    if (spread > limit) {
      reasons.push(
        `the ground-storey doors disagree about their height above the terrain next to them by ${f(spread)} m (more than the ${f(limit)} m margin), ` +
          'so no one height reference fits them all',
      );
    }
    for (const e of entries) {
      if (e.heightAboveTerrain === null) reasons.push(`ground-storey door #${e.expressId} has no terrain height next to it`);
      else if (e.heightAboveTerrain > entryAbove) {
        reasons.push(
          `ground-storey door #${e.expressId} sits ${f(e.heightAboveTerrain)} m above the terrain next to it (${f(e.adjacentTerrain!)} m), ` +
            `more than ${entryAbove} m: the model may be placed too high`,
        );
      }
    }
  }
  const bandNote =
    band.terrainMin !== null && band.terrainMax !== null
      ? `a ground storey between ${f(band.terrainMin - band.below)} and ${f(band.terrainMax + band.above)} m passes the building-level test`
      : 'the building-level test could not be made';
  if (reasons.length > 0) {
    return {
      status: 'unconfirmed',
      entryAbove,
      entries,
      allowance: null,
      unconfirmedBecause: reasons,
      residualRisk: {
        en:
          'The height reference of the model cannot be verified from the hazard map, and it could not be confirmed against the terrain ' +
          `next to the ground-storey doors (${reasons.join('; ')}). No element is reported above the mapped class range or as no runoff mapped. ` +
          `Only gross errors are caught: ${bandNote}.`,
        de:
          'Der Höhenbezug des Modells lässt sich aus der Gefährdungskarte nicht prüfen, und er konnte am Gelände neben den Türen des ' +
          `Erdgeschosses nicht bestätigt werden (${reasons.join('; ')}). Kein Element wird als über dem kartierten Klassenbereich oder als ` +
          `ohne kartierten Abfluss ausgewiesen. Erkannt werden nur grobe Fehler: ${bandNote}.`,
      },
    };
  }
  const highest = Math.max(...entries.map((e) => e.heightAboveTerrain!));
  const allowance = Math.max(0, highest);
  return {
    status: 'confirmed',
    entryAbove,
    entries,
    allowance,
    unconfirmedBecause: [],
    residualRisk: {
      en:
        `The height reference of the model cannot be verified from the hazard map. It was cross-checked only against the terrain next to ` +
        `${entries.length} ground-storey door(s): a height error of up to ${entryAbove} m relative to that terrain is not detectable. ` +
        `Every favourable outcome therefore needs ${f(allowance)} m more clearance (${ALLOWANCE_MEANING.en}); it is still wrong only if the model is placed too high by more than that, which would put every ground-storey ` +
        `door below the terrain next to it.`,
      de:
        `Der Höhenbezug des Modells lässt sich aus der Gefährdungskarte nicht prüfen. Er wurde nur am Gelände neben ${entries.length} ` +
        `Tür(en) des Erdgeschosses plausibilisiert: ein Höhenfehler bis ${entryAbove} m gegenüber diesem Gelände ist nicht erkennbar. ` +
        `Jedes günstige Ergebnis verlangt deshalb ${f(allowance)} m zusätzlichen Abstand (${ALLOWANCE_MEANING.de}); es ist nur dann falsch, wenn das Modell um mehr als das zu hoch liegt, womit jede Erdgeschosstür unter dem ` +
        `Gelände daneben läge.`,
    },
  };
}
