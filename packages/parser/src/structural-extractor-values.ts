/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { asString, type RawEntity } from './structural-step-values.js';
import { getInheritanceChain } from './ifc-schema.js';
import type { StructuralExtraction } from './structural-types.js';

export type StructuralRole =
  | 'member'
  | 'connection'
  | 'activity'
  | 'loadGroup'
  | 'resultGroup'
  | 'analysisModel';

/** Empty result shared by the parsed and live-overlay extractor paths. */
export function emptyStructuralExtraction(): StructuralExtraction {
  return {
    analysisModels: [], members: [], connections: [], activities: [],
    loadGroups: [], resultGroups: [], hasStructural: false, loadsTruncated: false,
  };
}

/** Chain marker → role. Every marker is disjoint, so match order is not load-bearing. */
const ROLE_BY_SUPERTYPE: ReadonlyArray<readonly [string, StructuralRole]> = [
  ['IFCSTRUCTURALANALYSISMODEL', 'analysisModel'],
  ['IFCSTRUCTURALRESULTGROUP', 'resultGroup'],
  ['IFCSTRUCTURALLOADGROUP', 'loadGroup'],
  ['IFCSTRUCTURALMEMBER', 'member'],
  ['IFCSTRUCTURALCONNECTION', 'connection'],
  ['IFCSTRUCTURALACTIVITY', 'activity'],
];

/**
 * Classify by inheritance, not by name. Unrelated `IFCSTRUCTURAL*` entities
 * such as load leaves and profile properties are intentionally skipped.
 */
export function structuralRoleOf(type: string): StructuralRole | undefined {
  const chain = getInheritanceChain(type).map((c) => c.toUpperCase());
  for (const [marker, role] of ROLE_BY_SUPERTYPE) {
    if (chain.includes(marker)) return role;
  }
  return undefined;
}

export function structuralActivityKind(type: string): 'Action' | 'Reaction' | 'Unknown' {
  const chain = getInheritanceChain(type).map((c) => c.toUpperCase());
  if (chain.includes('IFCSTRUCTURALACTION')) return 'Action';
  if (chain.includes('IFCSTRUCTURALREACTION')) return 'Reaction';
  return 'Unknown';
}

/** IfcRoot attribute 2 is Name, 3 Description; IfcObject adds ObjectType at 4. */
export function structuralRootFields(e: RawEntity): {
  name?: string;
  description?: string;
  objectType?: string;
} {
  return {
    name: asString(e.attrs[2]),
    description: asString(e.attrs[3]),
    objectType: asString(e.attrs[4]),
  };
}
