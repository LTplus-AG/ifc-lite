/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The check: a pure function of (model facts, classified hazard raster,
 * terrain sampler). It never fetches anything; {@link runFloodCheck} in
 * `run.ts` does the fetching and then calls this.
 *
 * Order: refuse on CRS / vertical CRS mismatch; plan the ground samples of
 * every candidate and read the terrain at all of them; refuse when the ground
 * storey is implausible against that terrain (`plausibility.ts`); size the
 * clearance margin (`margin.ts`); evaluate each candidate (`evaluate.ts`).
 */

import { FloodCheckRefusal } from '../errors.js';
import { normalizeCrs, sameCrs, verticalCrsIdentifier } from '../crs.js';
import type { CandidateFact, ModelFacts, SpaceFact } from '../model/facts.js';
import {
  CELL_NO_RUNOFF,
  type ClassifiedHazardRaster,
  type CoverageTest,
  type HazardClassDefinition,
  type HazardProvenance,
  type LocalizedText,
  type MapPoint,
  type RenderingConfirmation,
  type TerrainSampler,
} from '../types.js';
import { evaluateCandidate, type DrivingSample, type SampleCounts } from './evaluate.js';
import { deriveClearanceMargin, type MarginBasis, type MarginOptions } from './margin.js';
import type { LevelComparison, Outcome, UnclassifiedReason } from './outcome.js';
import { assessHeightReference, type HeightPlausibility, type PlausibilityOptions } from './plausibility.js';
import { planSamples, pointKey, resolveSampling, type ResolvedSampling, type SamplingOptions } from './sampling.js';
import { OUTCOME_MEANING, screeningCaveat } from './wording.js';

export type { DrivingSample, SampleCounts } from './evaluate.js';

export interface CheckOptions extends SamplingOptions, MarginOptions {
  /**
   * When some ground samples are unreadable edge pixels next to a class, a
   * deeper class may hide there. `'cannot-clear'` (default) withholds the
   * favourable outcome in that case; `'note'` only records it.
   */
  edgePolicy?: 'cannot-clear' | 'note';
  /**
   * An element whose position lies further than this inside the footprint
   * outline (metres) is anchored on the outline, but the ground there may not
   * be the ground in front of it: no favourable outcome. Default 1.0.
   */
  anchorTolerance?: number;
  /** The band the ground storey must lie in around the sampled terrain; see `plausibility.ts`. */
  heightPlausibility?: PlausibilityOptions;
  /** The provider's coverage perimeter; samples outside it are no data. Without it every sample on the raster counts as covered. */
  coverage?: CoverageTest;
  /**
   * The provider's answer to a rendering check. Required for a
   * `no-runoff-mapped` outcome when the whole raster is transparent; without
   * a confirmation such elements are `unclassified` (`layer-not-confirmed`).
   */
  renderingConfirmation?: RenderingConfirmation;
}

export interface CandidateResult {
  candidate: CandidateFact;
  outcome: Outcome;
  unclassifiedReason?: UnclassifiedReason;
  /** What the outcome establishes and what it does not. */
  meaning: LocalizedText;
  /** The screening caveat, with source and dataset date. */
  caveat: LocalizedText;
  /** The class at the sample that decides the outcome; null when none. */
  hazardClass: HazardClassDefinition | null;
  /** Terrain height at the deciding sample. */
  terrainHeight: number | null;
  comparison: LevelComparison | null;
  /** The sample that decides the outcome, with its numbers. */
  drivingSample: DrivingSample | null;
  /** Classified samples with terrain that were compared. */
  samplesCompared: number;
  /** Every class id found next to the element. */
  classesFound: string[];
  /** The margin used; null when it could not be sized. */
  clearanceMargin: number | null;
  anchor: MapPoint;
  anchorBasis: 'element' | 'nearest-outline-point';
  /** Metres the anchor was moved from the element's position to reach the outline. */
  anchorOffset: number;
  samples: SampleCounts;
  /** Why the favourable outcome was not given, when the outcome is `within-class-range` for one of these reasons. */
  favourableWithheldBecause: string[];
  notes: string[];
}

export interface ReachableSpace {
  space: SpaceFact;
  /** Exposed candidates above it whose water can reach it. Flagged, not sized. */
  via: number[];
}

export interface LayerCheck {
  /** Every cell of the raster is transparent. */
  rasterEmpty: boolean;
  /** The provider's rendering check, when one was made. */
  confirmation: RenderingConfirmation | null;
}

export interface FloodCheckResult {
  provenance: HazardProvenance;
  crs: string;
  /** The model's project length unit in metres, so property payloads can be written in it. */
  lengthUnitScale: number;
  /** Human-readable vertical reference of the terrain (its EPSG identifier when it states none). */
  terrainVerticalReference: string;
  /** How the model's vertical CRS relates to the terrain's, compared by EPSG identifier. */
  verticalDatum: {
    model: string | null;
    modelCrs: string | null;
    terrainCrs: string;
    basis: 'stated-and-equal' | 'not-stated-assumed-equal';
  };
  parameters: ResolvedSampling & {
    clearanceMargin: number | null;
    edgePolicy: 'cannot-clear' | 'note';
    anchorTolerance: number;
    rasterCellSize: number;
  };
  margin: MarginBasis;
  heightPlausibility: HeightPlausibility;
  layerCheck: LayerCheck;
  footprintSource: ModelFacts['footprint']['source'];
  groundStorey: ModelFacts['groundStorey'];
  /** The screening caveat every result carries. */
  caveat: LocalizedText;
  results: CandidateResult[];
  reachableBelowGround: ReachableSpace[];
  summary: Record<Outcome, number>;
  warnings: string[];
}

/** Refuse when the facts, raster and terrain do not share a CRS and (where the model states one) a vertical CRS. */
export function assertCompatible(facts: ModelFacts, rasterCrs: string, terrain: { crs: string; verticalCrs: string }): void {
  const crs = facts.georeference.crs;
  if (!sameCrs(crs, rasterCrs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is in ${crs}; the hazard map is in ${rasterCrs}`);
  }
  if (!sameCrs(crs, terrain.crs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is in ${crs}; the terrain is in ${terrain.crs}`);
  }
  const terrainVertical = normalizeCrs(terrain.verticalCrs);
  if (!terrainVertical) {
    throw new FloodCheckRefusal(
      'vertical-datum-unrecognised',
      `the terrain's verticalCrs "${terrain.verticalCrs}" is not an EPSG identifier (for example EPSG:5728 for LN02)`,
    );
  }
  const stated = facts.georeference.verticalDatum;
  if (!stated) return;
  const modelVertical = verticalCrsIdentifier(stated);
  if (!modelVertical) {
    throw new FloodCheckRefusal(
      'vertical-datum-unrecognised',
      `the model states vertical datum "${stated}", which names no known vertical CRS; it cannot be compared with the terrain's ${terrainVertical}`,
    );
  }
  if (modelVertical !== terrainVertical) {
    throw new FloodCheckRefusal(
      'vertical-datum-mismatch',
      `the model states vertical datum "${stated}" (${modelVertical}); the terrain is in ${terrainVertical}`,
    );
  }
}

/** Categories through which water can enter; equipment is damaged by water but is not a way in. */
const ENTRY_CATEGORIES: ReadonlySet<string> = new Set([
  'door', 'window', 'basement-window', 'wall-opening', 'slab-opening', 'light-well', 'stair', 'ramp',
]);

function reachableSpaces(facts: ModelFacts, results: readonly CandidateResult[]): ReachableSpace[] {
  const out = new Map<number, ReachableSpace>();
  for (const r of results) {
    if (r.outcome !== 'exposed' || r.terrainHeight === null || !ENTRY_CATEGORIES.has(r.candidate.category)) continue;
    const below = Math.min(r.candidate.level, r.terrainHeight);
    for (const space of facts.spaces) {
      if (space.floorLevel >= below) continue;
      const entry = out.get(space.expressId) ?? { space, via: [] };
      entry.via.push(r.candidate.expressId);
      out.set(space.expressId, entry);
    }
  }
  return [...out.values()].sort((a, b) => a.space.floorLevel - b.space.floorLevel);
}

function rasterIsEmpty(raster: ClassifiedHazardRaster): boolean {
  for (const c of raster.cells) if (c !== CELL_NO_RUNOFF) return false;
  return true;
}

/**
 * Check every candidate. Throws {@link FloodCheckRefusal} when CRS or vertical
 * CRS disagree, or when the ground storey is implausible against the terrain.
 */
export function checkFloodExposure(
  facts: ModelFacts,
  raster: ClassifiedHazardRaster,
  terrain: TerrainSampler,
  options: CheckOptions = {},
): FloodCheckResult {
  assertCompatible(facts, raster.crs, terrain);
  const s = resolveSampling(options);
  const edgePolicy = options.edgePolicy ?? 'cannot-clear';
  const anchorTolerance = options.anchorTolerance ?? 1;

  // Terrain at every ring point of every candidate: the plausibility test needs all of it.
  const plans = facts.candidates.map((c) => planSamples(c, facts.footprint, s));
  const heights = new Map<string, number | null>();
  const seen: number[] = [];
  for (const plan of plans) {
    for (const { point } of plan.points) {
      const key = pointKey(point);
      if (heights.has(key)) continue;
      const h = terrain.heightAt(point);
      const v = h !== null && Number.isFinite(h) ? h : null;
      heights.set(key, v);
      if (v !== null) seen.push(v);
    }
  }
  const heightPlausibility = assessHeightReference(facts.groundStorey.level, seen, options.heightPlausibility);
  const margin = deriveClearanceMargin(terrain.verticalAccuracy, options);
  const rasterEmpty = rasterIsEmpty(raster);
  const confirmation = options.renderingConfirmation ?? null;
  const caveat = screeningCaveat(raster.provenance);

  const results: CandidateResult[] = facts.candidates.map((candidate, i) => {
    const plan = plans[i];
    const e = evaluateCandidate(candidate, plan, {
      raster,
      heightAt: (p) => heights.get(pointKey(p)) ?? null,
      covers: options.coverage,
      margin: margin.margin,
      edgePolicy,
      anchorTolerance,
      footprintSource: facts.footprint.source,
      emptyRasterUnconfirmed: rasterEmpty && confirmation?.confirmed !== true,
    });
    return {
      candidate,
      outcome: e.outcome,
      ...(e.unclassifiedReason ? { unclassifiedReason: e.unclassifiedReason } : {}),
      meaning: OUTCOME_MEANING[e.outcome],
      caveat,
      hazardClass: e.driving?.hazardClass ?? null,
      terrainHeight: e.driving?.terrainHeight ?? null,
      comparison: e.driving?.comparison ?? null,
      drivingSample: e.driving,
      samplesCompared: e.samplesCompared,
      classesFound: e.classesFound,
      clearanceMargin: margin.margin,
      anchor: plan.anchor,
      anchorBasis: plan.anchorBasis,
      anchorOffset: plan.anchorOffset,
      samples: e.samples,
      favourableWithheldBecause: e.favourableWithheldBecause,
      notes: e.notes,
    };
  });
  const summary: Record<Outcome, number> = {
    'above-mapped-class-range': 0,
    exposed: 0,
    'within-class-range': 0,
    'open-ended-class': 0,
    'no-runoff-mapped': 0,
    unclassified: 0,
  };
  for (const r of results) summary[r.outcome]++;

  const warnings = [...facts.warnings];
  warnings.push(
    `The map is read at ${raster.cellSize} m cells next to each element. The publisher states the map must not be used at scales ` +
      'more detailed than its stated limit; treat every per-element result as screening, not as a site assessment.',
  );
  const stated = facts.georeference.verticalDatum;
  const terrainCrs = normalizeCrs(terrain.verticalCrs) ?? terrain.verticalCrs;
  if (!stated) {
    warnings.push(`The model states no vertical datum; its heights are taken to be in the terrain's ${terrainCrs}.`);
  }
  if (heightPlausibility.status === 'not-checked-no-terrain') {
    warnings.push('No terrain height was available next to the building, so the model height reference could not be checked.');
  }
  if (margin.margin === null) warnings.push(`Clearance margin ${margin.statement}.`);
  if (rasterEmpty) {
    warnings.push(
      confirmation?.confirmed
        ? `The whole raster is transparent; the layer was confirmed to render at a reference location (${confirmation.requestUrl}).`
        : `The whole raster is transparent and the layer could not be confirmed to render${confirmation ? ` (${confirmation.detail})` : ''}; ` +
            'transparent samples are not reported as "no runoff mapped".',
    );
  }
  return {
    provenance: raster.provenance,
    crs: facts.georeference.crs,
    lengthUnitScale: facts.georeference.lengthUnitScale,
    terrainVerticalReference: terrain.verticalReference ?? terrainCrs,
    verticalDatum: {
      model: stated,
      modelCrs: stated ? verticalCrsIdentifier(stated) : null,
      terrainCrs,
      basis: stated ? 'stated-and-equal' : 'not-stated-assumed-equal',
    },
    parameters: { ...s, clearanceMargin: margin.margin, edgePolicy, anchorTolerance, rasterCellSize: raster.cellSize },
    margin,
    heightPlausibility,
    layerCheck: { rasterEmpty, confirmation },
    footprintSource: facts.footprint.source,
    groundStorey: facts.groundStorey,
    caveat,
    results,
    reachableBelowGround: reachableSpaces(facts, results),
    summary,
    warnings,
  };
}
