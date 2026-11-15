/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The check: a pure function of (model facts, classified hazard raster,
 * terrain sampler). It never fetches anything; {@link runFloodCheck} in
 * `run.ts` does the fetching and then calls this.
 *
 * Order: refuse on CRS / vertical CRS mismatch; plan the ground samples of
 * every candidate and read the terrain at all of them and along the whole
 * footprint outline; refuse when the ground storey is implausible against that
 * terrain, and confirm the height reference against the ground-storey doors
 * (`plausibility.ts`); size the clearance margin (`margin.ts`); evaluate each
 * candidate (`evaluate.ts`).
 *
 * No option makes an outcome more favourable than the default, except by
 * supplying information (a stated terrain accuracy, a stated georeferencing
 * uncertainty, a real footprint, a rendering confirmation): tolerances can
 * only be tightened, and widening a refusal band yields results but no
 * favourable outcome.
 */

import { FloodCheckRefusal } from '../errors.js';
import { normalizeCrs, sameCrs, verticalCrsIdentifier } from '../crs.js';
import { fillsCourtyards, type BuildingScope, type CandidateFact, type ModelFacts, type SpaceFact } from '../model/facts.js';
import {
  type ClassifiedHazardRaster,
  type CoverageTest,
  type HazardClassDefinition,
  type HazardProvenance,
  type LocalizedText,
  type MapPoint,
  type RenderingConfirmation,
  type TerrainSampler,
} from '../types.js';
import { confirmationVouches, msBetween, rasterShowsNoClass } from './layer.js';
import { evaluateCandidate, type DrivingSample, type SampleCounts } from './evaluate.js';
import { deriveClearanceMargin, type MarginBasis, type MarginOptions } from './margin.js';
import type { LevelComparison, Outcome, UnclassifiedReason } from './outcome.js';
import {
  assessHeightReference,
  confirmEntries,
  type HeightPlausibility,
  type HeightReference,
  type PlausibilityOptions,
} from './plausibility.js';
import { outlineTerrainPoints, planSamples, pointKey, resolveSampling, type ResolvedSampling } from './sampling.js';
import { OUTCOME_MEANING, screeningCaveat } from './wording.js';

export type { DrivingSample, SampleCounts } from './evaluate.js';

export interface CheckOptions extends MarginOptions {
  /**
   * An element whose position lies further than this inside the footprint
   * outline (metres) is anchored on the outline, but the ground there may not
   * be the ground in front of it: no favourable outcome. Default 1.0; may
   * only be lowered.
   */
  anchorTolerance?: number;
  /** The band the ground storey must lie in, and the entry tolerance; see `plausibility.ts`. */
  heightPlausibility?: PlausibilityOptions;
  /** The provider's coverage perimeter; samples outside it are no data. Without it every sample on the raster counts as covered. */
  coverage?: CoverageTest;
  /**
   * The provider's answer to a rendering check. Required for a
   * `no-runoff-mapped` outcome when the whole raster is transparent; without
   * a confirmation such elements are `unclassified` (`layer-not-confirmed`),
   * and so they are when its reference was fetched more than 5 minutes apart
   * from the raster (`layer.ts`).
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
  /**
   * Why a favourable outcome was not given: set when the outcome is
   * `within-class-range` instead of `above-mapped-class-range`, or
   * `unclassified` instead of `no-runoff-mapped`.
   */
  favourableWithheldBecause: string[];
  /** What this run cannot detect about the model's height reference, with its numbers (same for every element). */
  residualRisk: LocalizedText;
  notes: string[];
}

export interface ReachableSpace {
  space: SpaceFact;
  /** Exposed candidates above it whose water can reach it. Flagged, not sized. */
  via: number[];
}

export interface LayerCheck {
  /** No cell of the raster carries a mapped class (every cell is transparent or an unreadable edge pixel). */
  rasterEmpty: boolean;
  /** The provider's rendering check, when one was made. */
  confirmation: RenderingConfirmation | null;
  /** The confirmation is positive and its reference was fetched within 5 minutes of the raster, so it vouches for it. */
  confirmationApplies: boolean;
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
    anchorTolerance: number;
    rasterCellSize: number;
  };
  margin: MarginBasis;
  heightPlausibility: HeightPlausibility;
  /** The entry-level check of the height reference and the residual risk it leaves. */
  heightReference: HeightReference;
  layerCheck: LayerCheck;
  footprintSource: ModelFacts['footprint']['source'];
  groundStorey: ModelFacts['groundStorey'];
  buildingScope: BuildingScope; // see BuildingScope; empty for hand-built facts without it
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

export { rasterShowsNoClass } from './layer.js';

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
  return checkWith(facts, raster, terrain, options, []);
}

export const DEFAULT_ANCHOR_TOLERANCE = 1;

/**
 * {@link checkFloodExposure} plus building-level reasons, found while
 * fetching, that make the reference unconfirmed (used by `run.ts`).
 */
export function checkWith(
  facts: ModelFacts,
  raster: ClassifiedHazardRaster,
  terrain: TerrainSampler,
  options: CheckOptions,
  unconfirmedBecause: readonly string[],
): FloodCheckResult {
  assertCompatible(facts, raster.crs, terrain);
  // A level that is not a finite height compares true or false by accident; refuse before any of it can read as evidence.
  const unusable = facts.candidates.find((c) => !Number.isFinite(c.level));
  if (unusable) {
    throw new FloodCheckRefusal(
      'georeference-implausible',
      `candidate #${unusable.expressId} (${unusable.ifcClass}) has level ${unusable.level}, not a finite height, so it cannot be compared with the hazard map; no element results are reported.`,
    );
  }
  const s = resolveSampling();
  const anchorTolerance = options.anchorTolerance ?? DEFAULT_ANCHOR_TOLERANCE;
  if (!(anchorTolerance >= 0) || anchorTolerance > DEFAULT_ANCHOR_TOLERANCE) {
    throw new RangeError(
      `anchorTolerance may only be lowered (0 to ${DEFAULT_ANCHOR_TOLERANCE} m), got ${anchorTolerance}: ` +
        'a larger value would report elements away from the outline as favourable on ground that may not be in front of them',
    );
  }

  // Terrain at every ring point of every candidate and along the whole outline: the height tests need all of it.
  const plans = facts.candidates.map((c) => planSamples(c, facts.footprint, s));
  const heights = new Map<string, number | null>();
  const seen: Array<{ point: MapPoint; height: number }> = [];
  const read = (point: MapPoint) => {
    const key = pointKey(point);
    if (heights.has(key)) return;
    const h = terrain.heightAt(point);
    const v = h !== null && Number.isFinite(h) ? h : null;
    heights.set(key, v);
    if (v !== null) seen.push({ point, height: v });
  };
  for (const plan of plans) for (const { point } of plan.points) read(point);
  for (const point of outlineTerrainPoints(facts.footprint, s)) read(point);
  const heightPlausibility = assessHeightReference(facts.groundStorey.level, seen, options.heightPlausibility);
  const heightAt = (p: MapPoint) => heights.get(pointKey(p)) ?? null;
  const hull = fillsCourtyards(facts.footprint.source);
  const heightReference = confirmEntries(
    facts,
    (i) => plans[i].points.map(({ point }) => heightAt(point)).filter((h): h is number => h !== null),
    (c, i) => !c.levelIsUpperEstimate && plans[i].anchorOffset <= anchorTolerance && !hull && !plans[i].nearestBoundaryNested,
    heightPlausibility,
    options.heightPlausibility,
    unconfirmedBecause,
  );
  const margin = deriveClearanceMargin(terrain.verticalAccuracy, options);
  const rasterEmpty = rasterShowsNoClass(raster);
  const confirmation = options.renderingConfirmation ?? null;
  const applies = confirmationVouches(confirmation, raster.provenance.retrievedAt);
  const caveat = screeningCaveat(raster.provenance);

  const results: CandidateResult[] = facts.candidates.map((candidate, i) => {
    const plan = plans[i];
    const e = evaluateCandidate(candidate, plan, {
      raster,
      heightAt,
      covers: options.coverage,
      margin: margin.margin,
      allowance: heightReference.allowance,
      anchorTolerance,
      footprintSource: facts.footprint.source,
      emptyRasterUnconfirmed: rasterEmpty && !applies,
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
      residualRisk: heightReference.residualRisk,
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
  if (heightReference.status === 'unconfirmed') {
    warnings.push(
      `Height reference unconfirmed (${heightReference.unconfirmedBecause.join('; ')}): no element is reported above the mapped class range or as no runoff mapped.`,
    );
  }
  warnings.push(heightReference.residualRisk.en);
  if (margin.georeferenceBasis === 'default-not-surveyed') {
    warnings.push(
      `The model's height reference is not stated to be surveyed, so the margin assumes ${margin.georeferenceVerticalUncertainty} m (1 sigma) for it; ` +
        'pass georeferenceVerticalUncertainty when it is known.',
    );
  }
  if (margin.margin === null) warnings.push(`Clearance margin ${margin.statement}.`);
  if (rasterEmpty) {
    warnings.push(
      applies
        ? `No cell of the raster shows a mapped class; the layer was confirmed to render at a reference location (${confirmation!.requestUrl}) at ${confirmation!.retrievedAt}.`
        : `No cell of the raster shows a mapped class and the layer could not be confirmed to render${!confirmation ? '' : confirmation.confirmed
          ? ` (its confirmation was fetched ${(msBetween(confirmation.retrievedAt, raster.provenance.retrievedAt) / 60000).toFixed(1)} min apart from the raster, more than 5 min)`
          : ` (${confirmation.detail})`}; ` +
            'transparent samples are not reported as "no runoff mapped".',
    );
  }
  return {
    provenance: confirmation ? { ...raster.provenance, renderingCheckedAt: confirmation.retrievedAt } : raster.provenance,
    crs: facts.georeference.crs,
    lengthUnitScale: facts.georeference.lengthUnitScale,
    terrainVerticalReference: terrain.verticalReference ?? terrainCrs,
    verticalDatum: {
      model: stated,
      modelCrs: stated ? verticalCrsIdentifier(stated) : null,
      terrainCrs,
      basis: stated ? 'stated-and-equal' : 'not-stated-assumed-equal',
    },
    parameters: { ...s, clearanceMargin: margin.margin, anchorTolerance, rasterCellSize: raster.cellSize },
    margin,
    heightPlausibility,
    heightReference,
    layerCheck: { rasterEmpty, confirmation, confirmationApplies: applies },
    footprintSource: facts.footprint.source,
    groundStorey: facts.groundStorey,
    buildingScope: facts.buildingScope ?? { checked: null, notChecked: [] },
    caveat,
    results,
    reachableBelowGround: reachableSpaces(facts, results),
    summary,
    warnings,
  };
}
