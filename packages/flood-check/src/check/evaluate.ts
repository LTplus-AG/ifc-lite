/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One element against the ground next to it. Every classified ground sample
 * is compared with its OWN terrain height and class, because a shallower class
 * on higher ground can put the water surface higher than a deeper class lower
 * down (a façade along a sloping street). With `z` the element level and, per
 * sample `i`, terrain `Ti` and class `(Li, Ui]`, margin `m` and height-reference
 * allowance `a` (`plausibility.ts`):
 *
 *   exposed                   some sample has z <= Ti + Li
 *   open-ended-class          none is exposed and some open-ended sample has z > Ti + Li
 *   above-mapped-class-range  every sample has z > Ti + Ui + m + a
 *   within-class-range        otherwise
 *   no-runoff-mapped          no sample shows a class (every one is transparent)
 *
 * The sample that decides the outcome is reported with its numbers: the most
 * deeply exposed one, the open-ended one closest to `z`, or the one with the
 * least room above its class.
 *
 * The two reassuring outcomes, `above-mapped-class-range` and
 * `no-runoff-mapped`, are guarded by the same list of conditions
 * ({@link GUARDS}). Any one of them downgrades `above-mapped-class-range` to
 * `within-class-range` and `no-runoff-mapped` to `unclassified` with the
 * condition's reason; the conditions are listed in `favourableWithheldBecause`.
 * `exposed` and `open-ended-class` are never withheld: they are the
 * conservative side. `within-class-range` is not reassuring and stays.
 *
 *   condition                                   above-mapped-class-range   no-runoff-mapped
 *   terrain states no vertical accuracy         -> within-class-range      -> unclassified (margin-not-sized)
 *   level is an upper estimate                  -> within-class-range      -> unclassified (level-upper-estimate)
 *   a sample is an edge pixel                   -> within-class-range      -> unclassified (map-edge-blend)
 *   a sample is off the raster                  -> within-class-range      -> unclassified (outside-raster)
 *   a sample is outside the map's coverage      -> within-class-range      -> unclassified (outside-coverage)
 *   a sample is in an area the map excluded     -> within-class-range      -> unclassified (excluded-area)
 *   anchor moved > anchorTolerance              -> within-class-range      -> unclassified (anchor-moved)
 *   footprint fills courtyards (hull, voids,    -> within-class-range      -> unclassified (hull-footprint)
 *     or oversized: beyond the external walls)
 *   nearest boundary is a nested (courtyard) ring -> within-class-range    -> unclassified (courtyard-ring)
 *   footprint partial (a source unreadable, a   -> within-class-range      -> unclassified (partial-footprint)
 *     wall or façade element outside it)
 *   height reference unconfirmed                -> within-class-range      -> unclassified (height-reference-unconfirmed)
 *   raster shows no class, layer unconfirmed    (no class to compare)      -> unclassified (layer-not-confirmed)
 *   a classified sample has no terrain          -> within-class-range      (no classified sample)
 *   clearance short of m + a, not of m          -> within-class-range      (no comparison)
 *   a sample lies inside another building       -> within-class-range      -> unclassified (other-building)
 *   a transparent sample, and no complete       -> within-class-range      -> unclassified (other-buildings-unknown)
 *     source of other buildings' footprints
 *   the position is uncertain                   -> within-class-range      -> unclassified (position-uncertain)
 *
 * "Layer unconfirmed": no rendering confirmation, a negative one, or a
 * positive one whose reference was fetched more than 5 minutes apart from the
 * raster (`layer.ts`).
 */

import { ALLOWANCE_MEANING } from './plausibility.js';
import { fillsCourtyards, type CandidateFact, type ModelFacts } from '../model/facts.js';
import type { ClassifiedHazardRaster, HazardClassDefinition, MapBBox, MapPoint } from '../types.js';
import { compareLevel, type LevelComparison, type Outcome, type UnclassifiedReason } from './outcome.js';
import { readCell, type SamplePlan } from './sampling.js';
import { insideExtent, insideOtherBuilding } from './other-buildings.js';

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
  /** Null when the margin cannot be sized. */
  margin: number | null;
  /** Height-reference allowance added to the margin for the favourable outcome; null when the reference is unconfirmed. */
  allowance: number | null;
  anchorTolerance: number;
  footprintSource: ModelFacts['footprint']['source'];
  /** From the footprint's quality record (`footprintConcerns`): it fills courtyards or notches (a hull, filled voids). */
  footprintHull?: boolean;
  /** From the same record: the footprint may miss part of the building. */
  footprintPartial?: boolean;
  /** No cell of the raster shows a mapped class and no positive confirmation fetched within 5 min of the raster vouches for it (`layer.ts`). */
  emptyRasterUnconfirmed: boolean;
  /** Other buildings' footprints (`CheckOptions.otherBuildings`); absent: transparent samples are unknown. */
  otherBuildings?: { rings: readonly (readonly MapPoint[])[]; complete: boolean; extent: MapBBox | null };
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
  const byReading: Record<string, number> = { 'no-runoff': 0, unclassified: 0, outside: 0, 'outside-coverage': 0, 'other-building': 0, 'beyond-buildings-extent': 0 };
  for (const c of raster.classes) byReading[c.id] = 0;
  const classified: Array<{ point: MapPoint; cls: HazardClassDefinition; terrain: number | null }> = [];
  let excluded = false;
  for (const { point } of plan.points) {
    const reading = readCell(raster, point);
    // Transparent inside another building is "raised, not modelled" (the hazard model raised every building).
    if (reading.kind === 'no-runoff' && ctx.otherBuildings && insideOtherBuilding(point, ctx.otherBuildings.rings)) {
      byReading['other-building']++;
      continue;
    }
    // A complete source vouches only inside its extent (a subset count of `no-runoff`).
    if (reading.kind === 'no-runoff' && !insideExtent(point, ctx.otherBuildings?.extent ?? null)) byReading['beyond-buildings-extent']++;
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

  const unreadable = byReading.unclassified + byReading.outside + byReading['outside-coverage'];
  const excludedSamples = raster.classes.filter((c) => c.kind === 'excluded').reduce((n, c) => n + byReading[c.id], 0);
  const guards = conditionsWithholding(candidate, plan, ctx, byReading, excludedSamples);
  if (unreadable > 0) {
    result.notes.push(`${unreadable} ground sample(s) unreadable (edge pixels, outside the raster or the map's coverage); a deeper class may lie there`);
  }

  if (classified.length === 0) {
    // Every sample is transparent, unreadable or excluded: "no runoff mapped" unless a guard applies.
    const first = guards[0];
    if (first) {
      result.unclassifiedReason = first.reason;
      result.favourableWithheldBecause = guards.map((g) => g.text);
      for (const g of guards) result.notes.push(`not reported as no runoff mapped: ${g.text}`);
    } else {
      result.outcome = 'no-runoff-mapped';
    }
    return result;
  }

  const entryAtTerrain = candidate.levelBasis === 'ground-storey-or-terrain';
  const required = ctx.margin === null ? Infinity : ctx.margin + (ctx.allowance ?? 0);
  const evaluated: DrivingSample[] = [];
  for (const c of classified) {
    if (c.terrain === null) continue;
    const level = entryAtTerrain ? Math.min(candidate.level, c.terrain) : candidate.level;
    evaluated.push({
      point: c.point,
      hazardClass: c.cls,
      terrainHeight: c.terrain,
      level,
      comparison: compareLevel(level, c.terrain, c.cls, required),
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

  const withheld = guards.map((g) => g.text);
  const noTerrain = classified.length - evaluated.length;
  if (noTerrain > 0) withheld.push(`${noTerrain} classified ground sample(s) have no terrain height`);
  const m = ctx.margin;
  const a = ctx.allowance ?? 0;
  if (
    result.outcome === 'within-class-range' &&
    m !== null &&
    a > 0 &&
    evaluated.every((e) => e.comparison.levelAboveSurfaceUpperBound !== null && e.comparison.levelAboveSurfaceUpperBound > m)
  ) {
    withheld.push(
      `the element clears the mapped class range by the ${m.toFixed(3)} m margin but not by the further ${a.toFixed(2)} m height-reference ` +
        `allowance (${ALLOWANCE_MEANING.en}, which could be a height error)`,
    );
  }
  if (result.outcome === 'above-mapped-class-range' && withheld.length > 0) result.outcome = 'within-class-range';
  if (result.outcome === 'within-class-range' && withheld.length > 0) {
    result.favourableWithheldBecause = withheld;
    for (const w of withheld) result.notes.push(`not reported above the mapped class range: ${w}`);
  }
  return result;
}

interface Guard {
  reason: UnclassifiedReason;
  text: string;
}

/** Every condition of the module table that applies to this element, in the order their reasons take precedence. */
function conditionsWithholding(
  candidate: CandidateFact,
  plan: SamplePlan,
  ctx: EvaluationContext,
  byReading: Record<string, number>,
  excludedSamples: number,
): Guard[] {
  const out: Guard[] = [];
  if (excludedSamples > 0) {
    out.push({ reason: 'excluded-area', text: `${excludedSamples} ground sample(s) lie in an area the map did not model (for example glacier)` });
  }
  if (byReading.unclassified > 0) out.push({ reason: 'map-edge-blend', text: `${byReading.unclassified} ground sample(s) are unreadable edge pixels` });
  if (byReading.outside > 0) out.push({ reason: 'outside-raster', text: `${byReading.outside} ground sample(s) lie outside the retrieved raster` });
  if (byReading['outside-coverage'] > 0) {
    out.push({ reason: 'outside-coverage', text: `${byReading['outside-coverage']} ground sample(s) lie outside, or too near the edge of, the area the map covers` });
  }
  if (ctx.emptyRasterUnconfirmed) {
    out.push({ reason: 'layer-not-confirmed', text: 'no cell of the raster shows a mapped class and the layer could not be confirmed to render' });
  }
  if (plan.anchorOffset > ctx.anchorTolerance) {
    out.push({
      reason: 'anchor-moved',
      text:
        `the element lies ${plan.anchorOffset.toFixed(2)} m inside the footprint outline (more than ${ctx.anchorTolerance} m), so the ground sampled ` +
        'at the outline may not be the ground in front of it (courtyard, notch or interior element)',
    });
  }
  if (ctx.footprintHull ?? fillsCourtyards(ctx.footprintSource)) {
    out.push({
      reason: 'hull-footprint',
      text: `the footprint is a ${ctx.footprintSource}, which fills courtyards or notches, so the ground sampled may not be in front of the element`,
    });
  }
  if (ctx.footprintPartial) {
    out.push({
      reason: 'partial-footprint',
      text: 'the footprint may miss part of the building (a ground-storey slab or external wall that cannot be read, or no outline at all), so the ground sampled may lie inside it',
    });
  }
  if (plan.nearestBoundaryNested) {
    out.push({
      reason: 'courtyard-ring',
      text:
        'the anchor was taken on, or the nearest footprint boundary is, a ring lying inside another ring (a courtyard), within the union of the others, which the footprint counts as inside the building, ' +
        'so the ground in front of the element is not sampled and any sample may lie on the far side of the building',
    });
  }
  if (ctx.allowance === null) {
    out.push({ reason: 'height-reference-unconfirmed', text: 'the height reference of the model could not be confirmed against the terrain next to its ground-storey doors' });
  }
  if (candidate.levelIsUpperEstimate) {
    out.push({ reason: 'level-upper-estimate', text: 'the level is an upper estimate (no lower edge could be read), so it can flag but not clear' });
  }
  if (ctx.margin === null) {
    out.push({ reason: 'margin-not-sized', text: 'the terrain source states no vertical accuracy, so the clearance margin cannot be sized' });
  }
  if (byReading['other-building'] > 0) {
    out.push({ reason: 'other-building', text: `${byReading['other-building']} ground sample(s) lie inside another building, which the hazard model raised (not modelled there)` });
  }
  // Transparency is "open ground, no runoff mapped" only with proof the sample is not inside a building the model omits.
  if (byReading['no-runoff'] > 0 && (ctx.otherBuildings?.complete !== true || byReading['beyond-buildings-extent'] > 0)) {
    out.push({
      reason: 'other-buildings-unknown',
      text:
        `${byReading['no-runoff']} transparent ground sample(s) may lie inside another building (an attached garage, a neighbour not in the model), ` +
        'which the hazard model raised; no complete source of other buildings\' footprints was supplied, so transparency there does not show open ground',
    });
  }
  if (candidate.positionIsUncertain) {
    out.push({
      reason: 'position-uncertain',
      text: 'the element\'s position is not proven (read from part of a body, or from a clipped body\'s outer operand), so the ground sampled may not be the ground in front of it',
    });
  }
  return out;
}
