/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the physical model and the structural analysis model in one file
 * disagree (#9668). Plain data in (the structural read model plus facts about
 * physical elements), issues out, in the shape `ifc-lite validate` reports.
 * `structuralConsistencyIssues` runs it on a parsed store; tests feed facts directly.
 *
 * Six rules, all warnings:
 * - `structural-unlinked-element`: a load-bearing beam, column, member, slab,
 *   wall, footing or pile with no structural item assigned. Runs only when the
 *   file has an analytical model (an IfcStructuralAnalysisModel or any
 *   structural member).
 * - `structural-unlinked-item`: a structural member or connection with no
 *   physical element assigned. Each kind is checked only in a file that links
 *   at least one item of that kind: a file that links none treats the kind as
 *   analysis-only.
 * - `structural-class-mismatch`: a curve member assigned to a slab or wall, or
 *   a surface member assigned to a beam, column or member.
 * - `structural-unconnected-member`: a structural member with no
 *   IfcRelConnectsStructuralMember. Runs only in a file where at least one
 *   member is connected: a file that connects none has no topology to check.
 * - `structural-axis-drift`: a curve member whose end lies farther than
 *   `axisDriftTolerance` from the line of a physical element it is assigned
 *   to. The distance is measured square to that line, so an end moved along
 *   the axis to meet another member (as the derivation does at joints) is not
 *   drift. Where along the axis a member lies is not checked. Runs only when
 *   `geometry` is given, for members and elements with a line there; surface
 *   members are not checked.
 * - `structural-stale-item`: a derived curve member whose physical element's
 *   line moved more than `staleTolerance` since the derivation wrote it. Derive
 *   records the element's GlobalId and its line, by the same rule as
 *   `physicalAxes`, on the member (`derivationRecords`); this rule compares
 *   that record with the element's line now. Unlike
 *   axis drift, it compares the physical element with itself, so a move along
 *   its own axis is reported and the member's own position is not read. Runs
 *   only when `geometry` is given, for members with a record whose element is
 *   still linked and has a line. Members without a record (authored, or derived
 *   before the record existed) are not checked.
 */

import { getInheritanceChain } from './ifc-schema.js';
import { structuralCounterparts } from './structural-counterparts.js';
import type { StructuralExtraction, StructuralMemberInfo } from './structural-types.js';

type Point = readonly [number, number, number];
/** A straight line from its first point to its second, in IFC world metres, Z up. */
export type StructuralLine = readonly [Point, Point];

/** The lines the axis-drift rule compares, by express id, in IFC world metres. */
export interface StructuralGeometryFacts {
  /** Each physical element's analytical line (the structural derivation's rule in `@ifc-lite/create`). */
  physicalAxes: ReadonlyMap<number, StructuralLine>;
  /** Each curve member's edge. */
  memberLines: ReadonlyMap<number, StructuralLine>;
  /** What derive recorded on each derived curve member, by the member's express id. */
  derivationRecords?: ReadonlyMap<number, StructuralDerivationRecord>;
}

/** The physical element a curve member was derived from, and that element's line at the time. */
export interface StructuralDerivationRecord {
  elementGlobalId: string;
  axis: StructuralLine;
}


/** One physical element as the checks see it. */
export interface PhysicalElementFact {
  expressId: number;
  globalId: string;
  /** The declared class, e.g. `IfcWallStandardCase`. */
  type: string;
  /**
   * `Pset_*Common.LoadBearing`, the occurrence's value over its type's; absent
   * when missing or not a boolean (IfcLogical UNKNOWN). The store adapter reads
   * it only for elements with no structural item assigned, the only ones a rule
   * asks about.
   */
  loadBearing?: boolean;
}

export interface StructuralConsistencyOptions {
  /**
   * Whether an element with no boolean LoadBearing counts as load
   * bearing. Default `true`: an unstated beam is reported rather than
   * silently passed. Explicit `LoadBearing = false` is never reported.
   */
  unsetLoadBearing?: boolean;
  /**
   * Metres a curve member's end may lie off its physical element's line
   * before the axis-drift rule reports it. Default
   * `DEFAULT_AXIS_DRIFT_TOLERANCE` (0.05), the structural derivation's default
   * node tolerance. The derivation moves member ends onto shared nodes, and
   * nodes merge transitively, so a derived end can sit somewhat more than its
   * node `tolerance` off its axis; check a model derived with a larger
   * tolerance with a larger value. Eccentricities
   * (`IfcRelConnectsWithEccentricity`) are not subtracted: a member placed off
   * its element's centre line by design is reported. A few units in the last
   * place of the coordinates are allowed above it, for rounding.
   */
  axisDriftTolerance?: number;
  /**
   * Metres either end of a physical element's line may move from where derive
   * recorded it before `structural-stale-item` reports its member. Default
   * `DEFAULT_STALE_TOLERANCE` (0.001): the record and the export keep full
   * precision, so only a real move exceeds it.
   */
  staleTolerance?: number;
}

export const DEFAULT_AXIS_DRIFT_TOLERANCE = 0.05;
export const DEFAULT_STALE_TOLERANCE = 0.001;
/** Metres: the most rounding the axis-drift rule allows above its tolerance. */
const DRIFT_ROUNDING_CAP = 1e-6;

export type StructuralConsistencyRule =
  | 'structural-unlinked-element'
  | 'structural-unlinked-item'
  | 'structural-class-mismatch'
  | 'structural-unconnected-member'
  | 'structural-axis-drift'
  | 'structural-stale-item';

/** One finding, in the `ValidationIssue` shape of `ifc-lite validate`. */
export interface StructuralConsistencyIssue {
  severity: 'warning';
  rule: StructuralConsistencyRule;
  message: string;
  /** Model-local express id of the entity the finding is about. */
  entityId: number;
  globalId: string;
  /** The entity on the other side of the link, when the finding has one. */
  target?: number;
  targetGlobalId?: string;
  /**
   * `structural-axis-drift`: metres from the member's farther end to the physical element's line.
   * `structural-stale-item`: metres the farther end of the element's line moved since derive.
   */
  distance?: number;
}

/** The classes rule 1 treats as load-bearing candidates; subtypes included. */
export const LOAD_BEARING_CLASSES: readonly string[] = ['IfcBeam', 'IfcColumn', 'IfcMember', 'IfcSlab', 'IfcWall', 'IfcFooting', 'IfcPile'];

/** Physical classes a structural member kind cannot idealise. Kept small: only clear mismatches. */
const MISMATCH: ReadonlyArray<{ member: string; noun: string; physical: readonly string[] }> = [
  { member: 'IfcStructuralCurveMember', noun: 'linear', physical: ['IfcSlab', 'IfcWall'] },
  { member: 'IfcStructuralSurfaceMember', noun: 'planar', physical: ['IfcBeam', 'IfcColumn', 'IfcMember'] },
];

/** Rule 1 runs only in a file with an analytical model: an IfcStructuralAnalysisModel or any structural member. */
export const hasAnalyticalModel = (structural: StructuralExtraction): boolean =>
  structural.analysisModels.length > 0 || structural.members.length > 0;

export const isA = (type: string, bases: readonly string[]): boolean => getInheritanceChain(type).some((name) => bases.includes(name));

/**
 * How far the farther end of `line` lies from the infinite line through
 * `axis`, and how much of that rounding alone can explain; null for a
 * degenerate axis. Each coordinate is stored to half a unit in the last place
 * (ulp) of its size, and the axis direction carries that error out to each
 * end in proportion to how far along the axis it lies. So the allowance is
 * 8 * EPSILON times the largest coordinate (8 to 16 ulps) times
 * (1 + along / span), with headroom: the seeded sweep in
 * `structural-consistency.test.ts` misreads none. It is capped at
 * `DRIFT_ROUNDING_CAP`, so a wild coordinate cannot hide drift. The cap binds
 * for a member many times longer than its element's axis at map coordinates;
 * far enough past the sweep's 41 axis lengths, an end exactly at the
 * tolerance can read as drift.
 */
function offLine(line: StructuralLine, [a, b]: StructuralLine): { distance: number; rounding: number } | null {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const span = Math.hypot(d[0], d[1], d[2]);
  if (!(span > 1e-9)) return null;
  const u = [d[0] / span, d[1] / span, d[2] / span];
  let distance = 0;
  let along = 0;
  let largest = 0;
  for (const p of [line[0], line[1], a, b]) for (const c of p) largest = Math.max(largest, Math.abs(c));
  for (const p of line) {
    const r = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const t = r[0] * u[0] + r[1] * u[1] + r[2] * u[2];
    // The component square to the axis: a difference of squares would lose
    // more precision than the subtraction of the coordinates.
    distance = Math.max(distance, Math.hypot(r[0] - t * u[0], r[1] - t * u[1], r[2] - t * u[2]));
    along = Math.max(along, Math.abs(t));
  }
  return { distance, rounding: Math.min(8 * Number.EPSILON * largest * (1 + along / span), DRIFT_ROUNDING_CAP) };
}

/** The axis-drift rule: each curve member with a line, against each linked element with an axis. */
function axisDrift(
  structural: StructuralExtraction,
  factById: ReadonlyMap<number, PhysicalElementFact>,
  { memberLines, physicalAxes }: StructuralGeometryFacts,
  tolerance: number,
): StructuralConsistencyIssue[] {
  const issues: StructuralConsistencyIssue[] = [];
  for (const member of structural.members) {
    const line = memberLines.get(member.expressId);
    if (!line) continue;
    for (const elementId of structuralCounterparts(structural, member.expressId)?.expressIds ?? []) {
      const fact = factById.get(elementId);
      const axis = physicalAxes.get(elementId);
      if (!fact || !axis) continue;
      const off = offLine(line, axis);
      // Not greater also skips NaN, from a non-finite coordinate.
      if (!off || !(off.distance > tolerance + off.rounding)) continue;
      issues.push({
        severity: 'warning', rule: 'structural-axis-drift', entityId: member.expressId, globalId: member.globalId,
        target: fact.expressId, targetGlobalId: fact.globalId, distance: off.distance,
        message: `${label(member.expressId, member.type, member.globalId)} lies ${off.distance.toFixed(3)} m off the axis of ${label(fact.expressId, fact.type, fact.globalId)} (tolerance ${tolerance} m)`,
      });
    }
  }
  return issues;
}

/** How far the farther end of `now` lies from where it was in `then`, matching ends either way round. */
function moved(now: StructuralLine, then: StructuralLine): number {
  const gap = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  return Math.min(Math.max(gap(now[0], then[0]), gap(now[1], then[1])), Math.max(gap(now[0], then[1]), gap(now[1], then[0])));
}

/** The stale rule: each derived member whose recorded element is still linked, against that element's line now. */
function staleItems(
  structural: StructuralExtraction,
  factById: ReadonlyMap<number, PhysicalElementFact>,
  { physicalAxes, derivationRecords }: StructuralGeometryFacts,
  tolerance: number,
): StructuralConsistencyIssue[] {
  const issues: StructuralConsistencyIssue[] = [];
  if (!derivationRecords) return issues;
  for (const member of structural.members) {
    const record = derivationRecords.get(member.expressId);
    if (!record) continue;
    const fact = (structuralCounterparts(structural, member.expressId)?.expressIds ?? [])
      .map((id) => factById.get(id)).find((candidate) => candidate?.globalId === record.elementGlobalId);
    const axis = fact && physicalAxes.get(fact.expressId);
    if (!fact || !axis) continue;
    const distance = moved(axis, record.axis);
    // Not greater also skips NaN, from a non-finite coordinate.
    if (!(distance > tolerance)) continue;
    issues.push({
      severity: 'warning', rule: 'structural-stale-item', entityId: member.expressId, globalId: member.globalId,
      target: fact.expressId, targetGlobalId: fact.globalId, distance,
      message: `${label(member.expressId, member.type, member.globalId)} is stale: ${label(fact.expressId, fact.type, fact.globalId)} moved ${distance.toFixed(3)} m since it was derived (tolerance ${tolerance} m)`,
    });
  }
  return issues;
}

const label = (expressId: number, type: string, globalId: string) => `#${expressId} ${type}${globalId ? ` (${globalId})` : ''}`;

export function checkStructuralConsistency(
  structural: StructuralExtraction,
  elements: readonly PhysicalElementFact[],
  options: StructuralConsistencyOptions = {},
  geometry?: StructuralGeometryFacts,
): StructuralConsistencyIssue[] {
  const unsetLoadBearing = options.unsetLoadBearing ?? true;
  const issues: StructuralConsistencyIssue[] = [];
  const factById = new Map(elements.map((fact) => [fact.expressId, fact]));

  if (hasAnalyticalModel(structural)) {
    for (const fact of elements) {
      if (!isA(fact.type, LOAD_BEARING_CLASSES)) continue;
      if (!(fact.loadBearing ?? unsetLoadBearing)) continue;
      if (structuralCounterparts(structural, fact.expressId)) continue;
      const why = fact.loadBearing === undefined ? 'LoadBearing is not stated as true or false' : 'LoadBearing is true';
      issues.push({
        severity: 'warning', rule: 'structural-unlinked-element', entityId: fact.expressId, globalId: fact.globalId,
        message: `${label(fact.expressId, fact.type, fact.globalId)} is load bearing (${why}) but no structural member or connection is assigned to it`,
      });
    }
  }

  for (const [items, noun] of [[structural.members, 'member'], [structural.connections, 'connection']] as const) {
    if (!items.some((item) => structuralCounterparts(structural, item.expressId))) continue;
    for (const item of items) {
      if (structuralCounterparts(structural, item.expressId)) continue;
      issues.push({
        severity: 'warning', rule: 'structural-unlinked-item', entityId: item.expressId, globalId: item.globalId,
        message: `${label(item.expressId, item.type, item.globalId)} has no physical element assigned, while other structural ${noun}s in this file do`,
      });
    }
  }

  for (const member of structural.members) {
    const row = MISMATCH.find((entry) => isA(member.type, [entry.member]));
    if (!row) continue;
    for (const elementId of structuralCounterparts(structural, member.expressId)?.expressIds ?? []) {
      const fact = factById.get(elementId);
      if (!fact || !isA(fact.type, row.physical)) continue;
      issues.push({
        severity: 'warning', rule: 'structural-class-mismatch', entityId: member.expressId, globalId: member.globalId,
        target: fact.expressId, targetGlobalId: fact.globalId,
        message: `${label(member.expressId, member.type, member.globalId)} idealises ${label(fact.expressId, fact.type, fact.globalId)}, but a ${row.noun} analytical member cannot stand for that class`,
      });
    }
  }

  const connected = (member: StructuralMemberInfo) => (member.IfcRelConnectsStructuralMember?.length ?? 0) > 0;
  if (structural.members.some(connected)) {
    for (const member of structural.members) {
      if (connected(member)) continue;
      issues.push({
        severity: 'warning', rule: 'structural-unconnected-member', entityId: member.expressId, globalId: member.globalId,
        message: `${label(member.expressId, member.type, member.globalId)} is connected to no structural connection, while other members in this file are`,
      });
    }
  }

  if (geometry) {
    const tolerance = options.axisDriftTolerance ?? DEFAULT_AXIS_DRIFT_TOLERANCE;
    if (!(tolerance >= 0)) throw new Error(`axisDriftTolerance must be a number of metres >= 0, got ${tolerance}`);
    issues.push(...axisDrift(structural, factById, geometry, tolerance));
    const staleTolerance = options.staleTolerance ?? DEFAULT_STALE_TOLERANCE;
    if (!(staleTolerance >= 0)) throw new Error(`staleTolerance must be a number of metres >= 0, got ${staleTolerance}`);
    issues.push(...staleItems(structural, factById, geometry, staleTolerance));
  }

  return issues;
}
