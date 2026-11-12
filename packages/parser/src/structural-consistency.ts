/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where the physical model and the structural analysis model in one file
 * disagree (#9668). Plain data in (the structural read model plus facts about
 * physical elements), issues out, in the shape `ifc-lite validate` reports.
 * `structuralConsistencyIssues` runs it on a parsed store; tests feed facts directly.
 *
 * Three rules, all warnings:
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
 *   drift. Runs only when `geometry` is given, for members and elements with
 *   a line there; surface members are not checked.
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
   * node tolerance. A model derived with a larger node `tolerance` can move
   * member ends up to that far off their element's axis at joints: check it
   * with at least that tolerance.
   */
  axisDriftTolerance?: number;
}

export const DEFAULT_AXIS_DRIFT_TOLERANCE = 0.05;

export type StructuralConsistencyRule =
  | 'structural-unlinked-element'
  | 'structural-unlinked-item'
  | 'structural-class-mismatch'
  | 'structural-unconnected-member'
  | 'structural-axis-drift';

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
  /** `structural-axis-drift`: metres from the member's farther end to the physical element's line. */
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

const isA = (type: string, bases: readonly string[]): boolean => getInheritanceChain(type).some((name) => bases.includes(name));

/** How far the farther end of `line` lies from the infinite line through `axis`; null for a degenerate axis. */
function offLine(line: StructuralLine, [a, b]: StructuralLine): number | null {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const span = Math.hypot(d[0], d[1], d[2]);
  if (!(span > 1e-9)) return null;
  return Math.max(...line.map((p) => {
    const r = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const along = (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) / span;
    return Math.sqrt(Math.max(0, r[0] * r[0] + r[1] * r[1] + r[2] * r[2] - along * along));
  }));
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
    for (const elementId of line ? structuralCounterparts(structural, member.expressId)?.expressIds ?? [] : []) {
      const fact = factById.get(elementId);
      const axis = physicalAxes.get(elementId);
      const distance = line && fact && axis ? offLine(line, axis) : null;
      if (!fact || distance === null || distance <= tolerance) continue;
      issues.push({
        severity: 'warning', rule: 'structural-axis-drift', entityId: member.expressId, globalId: member.globalId,
        target: fact.expressId, targetGlobalId: fact.globalId, distance,
        message: `${label(member.expressId, member.type, member.globalId)} lies ${distance.toFixed(3)} m off the axis of ${label(fact.expressId, fact.type, fact.globalId)} (tolerance ${tolerance} m)`,
      });
    }
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
  const tolerance = options.axisDriftTolerance ?? DEFAULT_AXIS_DRIFT_TOLERANCE;
  if (!(tolerance >= 0)) throw new Error(`axisDriftTolerance must be a number of metres >= 0, got ${tolerance}`);
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

  // A relationship counts even when its connection has no GlobalId to list.
  const connected = (member: StructuralMemberInfo) => member.connectionGlobalIds.length > 0 || (member.IfcRelConnectsStructuralMember?.length ?? 0) > 0;
  if (structural.members.some(connected)) {
    for (const member of structural.members) {
      if (connected(member)) continue;
      issues.push({
        severity: 'warning', rule: 'structural-unconnected-member', entityId: member.expressId, globalId: member.globalId,
        message: `${label(member.expressId, member.type, member.globalId)} is connected to no structural connection, while other members in this file are`,
      });
    }
  }

  if (geometry) issues.push(...axisDrift(structural, factById, geometry, tolerance));

  return issues;
}
