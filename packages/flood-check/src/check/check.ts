/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The check: a pure function of (model facts, classified hazard raster,
 * terrain sampler). It never fetches anything; {@link runFloodCheck} in
 * `run.ts` does the fetching and then calls this.
 */

import { FloodCheckRefusal } from '../errors.js';
import { normalizeVerticalDatum, sameCrs, sameVerticalDatum } from '../crs.js';
import type { CandidateFact, ModelFacts, SpaceFact } from '../model/facts.js';
import type {
  ClassifiedHazardRaster,
  HazardClassDefinition,
  HazardProvenance,
  MapPoint,
  TerrainSampler,
} from '../types.js';
import { compareLevel, moreSevere, type LevelComparison, type Outcome, type UnclassifiedReason } from './outcome.js';
import { planSamples, readCell, resolveSampling, type ResolvedSampling, type SamplingOptions } from './sampling.js';

export interface CheckOptions extends SamplingOptions {
  /** Extra height an element must sit above the class's highest water surface to be cleared, metres. Default 0.5. */
  clearanceMargin?: number;
  /**
   * When some ground samples are unreadable edge pixels next to a class, a
   * deeper class may hide there. `'cannot-clear'` (default) downgrades a
   * `clear` to `within-class-range` in that case; `'note'` only records it.
   */
  edgePolicy?: 'cannot-clear' | 'note';
}

export interface SampleCounts {
  /** Ring points considered. */
  planned: number;
  /** Ring points dropped for lying inside or within `minOutsideDistance` of the footprint. */
  insideFootprint: number;
  /** Per class id, plus `no-runoff`, `unclassified` and `outside`. */
  byReading: Record<string, number>;
}

export interface CandidateResult {
  candidate: CandidateFact;
  outcome: Outcome;
  unclassifiedReason?: UnclassifiedReason;
  /** The most severe class found on the ground next to the element; null when none. */
  hazardClass: HazardClassDefinition | null;
  /** Terrain height used for the comparison (highest among the samples of the governing class). */
  terrainHeight: number | null;
  comparison: LevelComparison | null;
  clearanceMargin: number;
  anchor: MapPoint;
  anchorBasis: 'element' | 'nearest-outline-point';
  /** The sample whose terrain height was used. */
  governingSample: MapPoint | null;
  samples: SampleCounts;
  notes: string[];
}

export interface ReachableSpace {
  space: SpaceFact;
  /** Exposed candidates above it whose water can reach it. Flagged, not sized. */
  via: number[];
}

export interface FloodCheckResult {
  provenance: HazardProvenance;
  crs: string;
  /** The model's project length unit in metres, so property payloads can be written in it. */
  lengthUnitScale: number;
  terrainVerticalReference: string;
  /** How the model's vertical datum relates to the terrain's. */
  verticalDatum: { model: string | null; terrain: string; basis: 'stated-and-equal' | 'not-stated-assumed-equal' };
  parameters: ResolvedSampling & { clearanceMargin: number; edgePolicy: 'cannot-clear' | 'note'; rasterCellSize: number };
  footprintSource: ModelFacts['footprint']['source'];
  groundStorey: ModelFacts['groundStorey'];
  results: CandidateResult[];
  reachableBelowGround: ReachableSpace[];
  summary: Record<Outcome, number>;
  warnings: string[];
}

/** Refuse when the facts, raster and terrain do not share a CRS and (where stated) a vertical datum. */
export function assertCompatible(facts: ModelFacts, rasterCrs: string, terrain: { crs: string; verticalReference: string }): void {
  const crs = facts.georeference.crs;
  if (!sameCrs(crs, rasterCrs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is in ${crs}; the hazard map is in ${rasterCrs}`);
  }
  if (!sameCrs(crs, terrain.crs)) {
    throw new FloodCheckRefusal('crs-mismatch', `the model is in ${crs}; the terrain is in ${terrain.crs}`);
  }
  const stated = facts.georeference.verticalDatum;
  if (stated && !sameVerticalDatum(stated, terrain.verticalReference)) {
    throw new FloodCheckRefusal(
      'vertical-datum-mismatch',
      `the model states vertical datum "${stated}" (${normalizeVerticalDatum(stated)}); the terrain is in ` +
        `"${terrain.verticalReference}" (${normalizeVerticalDatum(terrain.verticalReference)})`,
    );
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function checkCandidate(
  candidate: CandidateFact,
  facts: ModelFacts,
  raster: ClassifiedHazardRaster,
  terrain: TerrainSampler,
  s: ResolvedSampling,
  margin: number,
  edgePolicy: 'cannot-clear' | 'note',
  terrainSeen: number[],
): CandidateResult {
  const plan = planSamples(candidate, facts.footprint, s);
  const byReading: Record<string, number> = { 'no-runoff': 0, unclassified: 0, outside: 0 };
  for (const c of raster.classes) byReading[c.id] = 0;
  let governing: HazardClassDefinition | null = null;
  let governingPoints: MapPoint[] = [];
  let excluded = false;
  for (const { point } of plan.points) {
    const reading = readCell(raster, point);
    if (reading.kind !== 'class') {
      byReading[reading.kind]++;
      continue;
    }
    const cls = raster.classes[reading.code - 1];
    byReading[cls.id]++;
    if (cls.kind === 'excluded') {
      excluded = true;
      continue;
    }
    if (!governing || moreSevere(cls, governing)) {
      governing = cls;
      governingPoints = [point];
    } else if (cls.id === governing.id) {
      governingPoints.push(point);
    }
  }
  const result: CandidateResult = {
    candidate,
    outcome: 'unclassified',
    hazardClass: governing,
    terrainHeight: null,
    comparison: null,
    clearanceMargin: margin,
    anchor: plan.anchor,
    anchorBasis: plan.anchorBasis,
    governingSample: null,
    samples: { planned: plan.points.length + plan.rejected, insideFootprint: plan.rejected, byReading },
    notes: [],
  };
  if (plan.points.length === 0) {
    result.unclassifiedReason = 'no-ground-sample';
    return result;
  }
  if (!governing) {
    if (excluded) result.unclassifiedReason = 'excluded-area';
    else if (byReading.unclassified > 0) result.unclassifiedReason = 'map-edge-blend';
    else if (byReading.outside > 0) result.unclassifiedReason = 'outside-raster';
    else result.outcome = 'no-runoff-mapped';
    return result;
  }
  // Conservative: the highest terrain among the samples showing the governing class.
  let best: { point: MapPoint; h: number } | null = null;
  for (const point of governingPoints) {
    const h = terrain.heightAt(point);
    if (h === null || !Number.isFinite(h)) continue;
    terrainSeen.push(h);
    if (!best || h > best.h) best = { point, h };
  }
  if (!best) {
    result.unclassifiedReason = 'no-terrain';
    return result;
  }
  result.terrainHeight = best.h;
  result.governingSample = best.point;
  const comparison = compareLevel(candidate.level, best.h, governing, margin);
  result.comparison = comparison;
  result.outcome = comparison.outcome;
  if (result.outcome === 'clear' && candidate.levelIsUpperEstimate) {
    result.outcome = 'within-class-range';
    result.notes.push('the level is an upper estimate (no top edge could be read), so it can flag but not clear');
  }
  const unreadable = byReading.unclassified + byReading.outside;
  if (unreadable > 0) {
    result.notes.push(`${unreadable} ground sample(s) unreadable (edge pixels or outside the raster); a deeper class may lie there`);
    if (result.outcome === 'clear' && edgePolicy === 'cannot-clear') result.outcome = 'within-class-range';
  }
  return result;
}

function reachableSpaces(facts: ModelFacts, results: readonly CandidateResult[]): ReachableSpace[] {
  const out = new Map<number, ReachableSpace>();
  for (const r of results) {
    if (r.outcome !== 'exposed' || r.terrainHeight === null) continue;
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

/** Check every candidate. Throws {@link FloodCheckRefusal} when CRS or vertical datum disagree. */
export function checkFloodExposure(
  facts: ModelFacts,
  raster: ClassifiedHazardRaster,
  terrain: TerrainSampler,
  options: CheckOptions = {},
): FloodCheckResult {
  assertCompatible(facts, raster.crs, terrain);
  const s = resolveSampling(options);
  const margin = options.clearanceMargin ?? 0.5;
  const edgePolicy = options.edgePolicy ?? 'cannot-clear';
  const terrainSeen: number[] = [];
  const results = facts.candidates.map((c) => checkCandidate(c, facts, raster, terrain, s, margin, edgePolicy, terrainSeen));
  const summary: Record<Outcome, number> = {
    clear: 0,
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
  if (!stated) {
    warnings.push(`The model states no vertical datum; its heights are taken to be in the terrain's ${terrain.verticalReference}.`);
  }
  const groundTerrain = median(terrainSeen);
  if (groundTerrain !== null && Math.abs(facts.groundStorey.level - groundTerrain) > 1.5) {
    warnings.push(
      `The ground storey level (${facts.groundStorey.level.toFixed(2)} m) is ${(facts.groundStorey.level - groundTerrain).toFixed(2)} m from ` +
        `the median terrain next to the building (${groundTerrain.toFixed(2)} m): check groundStorey, the model's OrthogonalHeight and the vertical datum.`,
    );
  }
  return {
    provenance: raster.provenance,
    crs: facts.georeference.crs,
    lengthUnitScale: facts.georeference.lengthUnitScale,
    terrainVerticalReference: terrain.verticalReference,
    verticalDatum: {
      model: stated,
      terrain: terrain.verticalReference,
      basis: stated ? 'stated-and-equal' : 'not-stated-assumed-equal',
    },
    parameters: { ...s, clearanceMargin: margin, edgePolicy, rasterCellSize: raster.cellSize },
    footprintSource: facts.footprint.source,
    groundStorey: facts.groundStorey,
    results,
    reachableBelowGround: reachableSpaces(facts, results),
    summary,
    warnings,
  };
}
