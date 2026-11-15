/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One element against the ground next to it. Every classified ground sample
 * is compared with its OWN terrain height and class, because a shallower class
 * on higher ground can put the water surface higher than a deeper class lower
 * down (a façade along a sloping street). With `z` the element level and, per
 * sample `i`, terrain `Ti` and class `(Li, Ui]`:
 *
 *   exposed                   some sample has z <= Ti + Li
 *   open-ended-class          none is exposed and some open-ended sample has z > Ti + Li
 *   above-mapped-class-range  every sample has z > Ti + Ui + m
 *   within-class-range        otherwise
 *
 * The sample that decides the outcome is reported with its numbers: the most
 * deeply exposed one, the open-ended one closest to `z`, or the one with the
 * least room above its class. The favourable outcome is further withheld
 * (reported as `within-class-range`, with the reason) when the margin cannot
 * be sized, the level is an upper estimate, samples are unreadable or lie in an
 * area the map did not model, a classified sample has no terrain, the element had to be moved to reach the
 * footprint outline, or the footprint is only a hull.
 */

import type { CandidateFact, ModelFacts } from '../model/facts.js';
import type { ClassifiedHazardRaster, CoverageTest, HazardClassDefinition, MapPoint } from '../types.js';
import { compareLevel, type LevelComparison, type Outcome, type UnclassifiedReason } from './outcome.js';
import { readCell, type SamplePlan } from './sampling.js';

export interface SampleCounts {
  /** Ring points considered. */
  planned: number;
  /** Ring points dropped for lying inside or within `minOutsideDistance` of the footprint. */
  insideFootprint: number;
  /** Per class id, plus `no-runoff`, `unclassified`, `outside` and `outside-coverage`. */
  byReading: Record<string, number>;
}

/** The ground sample that decides an element's outcome. */
export interface DrivingSample {
  point: MapPoint;
  hazardClass: HazardClassDefinition;
  terrainHeight: number;
  /** The level compared: the element level, or for an entry at terrain the lower of it and the terrain. */
  level: number;
  comparison: LevelComparison;
}

export interface Evaluation {
  outcome: Outcome;
  unclassifiedReason?: UnclassifiedReason;
  driving: DrivingSample | null;
  /** Classified samples with a terrain height that were compared. */
  samplesCompared: number;
  /** Ids of every class found on the ground next to the element. */
  classesFound: string[];
  samples: SampleCounts;
  /** Why the favourable outcome was not given, when the comparison alone would have given it or could not. */
  favourableWithheldBecause: string[];
  notes: string[];
}

export interface EvaluationContext {
  raster: ClassifiedHazardRaster;
  heightAt(point: MapPoint): number | null;
  covers?: CoverageTest;
  /** Null when the margin cannot be sized. */
  margin: number | null;
  edgePolicy: 'cannot-clear' | 'note';
  anchorTolerance: number;
  footprintSource: ModelFacts['footprint']['source'];
  /** The whole raster is transparent and the provider did not confirm the layer renders. */
  emptyRasterUnconfirmed: boolean;
}

const fmt = (v: number) => v.toFixed(3);

function pickDriver(evaluated: DrivingSample[]): DrivingSample {
  const by = (kind: LevelComparison['outcome']) => evaluated.filter((e) => e.comparison.outcome === kind);
  const minBy = (list: DrivingSample[], key: (e: DrivingSample) => number) =>
    list.reduce((a, b) => (key(b) < key(a) ? b : a));
  const exposed = by('exposed');
  if (exposed.length > 0) return minBy(exposed, (e) => e.comparison.levelAboveSurfaceLowerBound);
  const open = by('open-ended-class');
  if (open.length > 0) return minBy(open, (e) => e.comparison.levelAboveSurfaceLowerBound);
  const within = by('within-class-range');
  const pool = within.length > 0 ? within : evaluated;
  return minBy(pool, (e) => e.comparison.levelAboveSurfaceUpperBound ?? -Infinity);
}

export function evaluateCandidate(candidate: CandidateFact, plan: SamplePlan, ctx: EvaluationContext): Evaluation {
  const { raster } = ctx;
  const byReading: Record<string, number> = { 'no-runoff': 0, unclassified: 0, outside: 0, 'outside-coverage': 0 };
  for (const c of raster.classes) byReading[c.id] = 0;
  const classified: Array<{ point: MapPoint; cls: HazardClassDefinition; terrain: number | null }> = [];
  let excluded = false;
  for (const { point } of plan.points) {
    const reading = readCell(raster, point, ctx.covers);
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
    const h = ctx.heightAt(point);
    classified.push({ point, cls, terrain: h !== null && Number.isFinite(h) ? h : null });
  }
  const result: Evaluation = {
    outcome: 'unclassified',
    driving: null,
    samplesCompared: 0,
    classesFound: [...new Set(classified.map((c) => c.cls.id))],
    samples: { planned: plan.points.length + plan.rejected, insideFootprint: plan.rejected, byReading },
    favourableWithheldBecause: [],
    notes: [...(candidate.notes ?? [])],
  };
  if (excluded) result.classesFound.push(...raster.classes.filter((c) => c.kind === 'excluded' && byReading[c.id] > 0).map((c) => c.id));
  if (plan.points.length === 0) {
    result.unclassifiedReason = 'no-ground-sample';
    return result;
  }
  if (classified.length === 0) {
    if (excluded) result.unclassifiedReason = 'excluded-area';
    else if (byReading.unclassified > 0) result.unclassifiedReason = 'map-edge-blend';
    else if (byReading.outside > 0) result.unclassifiedReason = 'outside-raster';
    else if (byReading['outside-coverage'] > 0) result.unclassifiedReason = 'outside-coverage';
    else if (ctx.emptyRasterUnconfirmed) result.unclassifiedReason = 'layer-not-confirmed';
    else result.outcome = 'no-runoff-mapped';
    return result;
  }
  const entryAtTerrain = candidate.levelBasis === 'ground-storey-or-terrain';
  const evaluated: DrivingSample[] = [];
  for (const c of classified) {
    if (c.terrain === null) continue;
    const level = entryAtTerrain ? Math.min(candidate.level, c.terrain) : candidate.level;
    evaluated.push({
      point: c.point,
      hazardClass: c.cls,
      terrainHeight: c.terrain,
      level,
      comparison: compareLevel(level, c.terrain, c.cls, ctx.margin ?? Infinity),
    });
  }
  if (evaluated.length === 0) {
    result.unclassifiedReason = 'no-terrain';
    return result;
  }
  const driver = pickDriver(evaluated);
  result.driving = driver;
  result.samplesCompared = evaluated.length;
  result.outcome = driver.comparison.outcome;
  result.notes.push(
    `decided by ${driver.hazardClass.id} at E ${driver.point.x.toFixed(2)}, N ${driver.point.y.toFixed(2)}: ` +
      `terrain ${fmt(driver.terrainHeight)} m, water surface ${fmt(driver.comparison.surfaceLowerBound)}` +
      `${driver.comparison.surfaceUpperBound === null ? '+' : `..${fmt(driver.comparison.surfaceUpperBound)}`} m, ` +
      `level ${fmt(driver.level)} m (${evaluated.length} classified sample(s) compared)`,
  );
  if (entryAtTerrain && driver.level < candidate.level) {
    result.notes.push('the entry is at terrain, which lies below the ground storey here, so the terrain is the level compared');
  }

  const withheld: string[] = [];
  if (ctx.margin === null) withheld.push('the terrain source states no vertical accuracy, so the clearance margin cannot be sized');
  if (candidate.levelIsUpperEstimate) withheld.push('the level is an upper estimate (no lower edge could be read), so it can flag but not clear');
  const unreadable = byReading.unclassified + byReading.outside + byReading['outside-coverage'];
  if (unreadable > 0) {
    result.notes.push(`${unreadable} ground sample(s) unreadable (edge pixels, outside the raster or the map's coverage); a deeper class may lie there`);
    if (ctx.edgePolicy === 'cannot-clear') withheld.push(`${unreadable} ground sample(s) are unreadable`);
  }
  const excludedSamples = raster.classes.filter((c) => c.kind === 'excluded').reduce((n, c) => n + byReading[c.id], 0);
  if (excludedSamples > 0) withheld.push(`${excludedSamples} ground sample(s) lie in an area the map did not model (for example glacier)`);
  const noTerrain = classified.length - evaluated.length;
  if (noTerrain > 0) withheld.push(`${noTerrain} classified ground sample(s) have no terrain height`);
  if (plan.anchorOffset > ctx.anchorTolerance) {
    withheld.push(
      `the element lies ${plan.anchorOffset.toFixed(2)} m inside the footprint outline (more than ${ctx.anchorTolerance} m), so the ground sampled ` +
        'at the outline may not be the ground in front of it (courtyard, notch or interior element)',
    );
  }
  if (ctx.footprintSource === 'external-wall-hull' || ctx.footprintSource === 'candidate-hull') {
    withheld.push(`the footprint is a ${ctx.footprintSource}, which fills courtyards and notches, so the ground sampled may not be in front of the element`);
  }
  if (result.outcome === 'above-mapped-class-range' && withheld.length > 0) result.outcome = 'within-class-range';
  if (result.outcome === 'within-class-range' && withheld.length > 0) {
    result.favourableWithheldBecause = withheld;
    for (const w of withheld) result.notes.push(`not reported above the mapped class range: ${w}`);
  }
  return result;
}
