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
 *   wall or footing with no structural item assigned. Runs only when the file
 *   has an analytical model (an IfcStructuralAnalysisModel or any structural
 *   member).
 * - `structural-unlinked-item`: a structural member or connection with no
 *   physical element assigned. Each kind is checked only in a file that links
 *   at least one item of that kind: a file that links none treats the kind as
 *   analysis-only.
 * - `structural-class-mismatch`: a curve member assigned to a slab or wall, or
 *   a surface member assigned to a beam, column or member.
 */

import { getInheritanceChain } from './ifc-schema.js';
import { structuralCounterparts } from './structural-counterparts.js';
import type { StructuralExtraction } from './structural-types.js';

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
}

export type StructuralConsistencyRule =
  | 'structural-unlinked-element'
  | 'structural-unlinked-item'
  | 'structural-class-mismatch';

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
}

/** The classes rule 1 treats as load-bearing candidates; subtypes included. */
export const LOAD_BEARING_CLASSES: readonly string[] = ['IfcBeam', 'IfcColumn', 'IfcMember', 'IfcSlab', 'IfcWall', 'IfcFooting'];

/** Physical classes a structural member kind cannot idealise. Kept small: only clear mismatches. */
const MISMATCH: ReadonlyArray<{ member: string; noun: string; physical: readonly string[] }> = [
  { member: 'IfcStructuralCurveMember', noun: 'linear', physical: ['IfcSlab', 'IfcWall'] },
  { member: 'IfcStructuralSurfaceMember', noun: 'planar', physical: ['IfcBeam', 'IfcColumn', 'IfcMember'] },
];

/** Rule 1 runs only in a file with an analytical model: an IfcStructuralAnalysisModel or any structural member. */
export const hasAnalyticalModel = (structural: StructuralExtraction): boolean =>
  structural.analysisModels.length > 0 || structural.members.length > 0;

const isA = (type: string, bases: readonly string[]): boolean => getInheritanceChain(type).some((name) => bases.includes(name));

const label = (expressId: number, type: string, globalId: string) => `#${expressId} ${type}${globalId ? ` (${globalId})` : ''}`;

export function checkStructuralConsistency(
  structural: StructuralExtraction,
  elements: readonly PhysicalElementFact[],
  options: StructuralConsistencyOptions = {},
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

  return issues;
}
