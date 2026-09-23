/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `group` — membership in an `IfcGroup` through `IfcRelAssignsToGroup`
 * (#5226): "every AHU is assigned to a system". The one vocabulary entry
 * both search/applicability and validation requirements read, like every
 * other `FilterRule` kind. Own module because `filter-rules.ts` sits at the
 * module-size cap.
 *
 * An element's candidates are the Names of every group it is assigned to,
 * optionally only groups of one IFC class (`groupClass`, subclasses
 * included: `IfcSystem` also takes `IfcDistributionSystem` and
 * `IfcBuildingSystem`). `isSet` / `isNotSet` ask whether there is any such
 * group at all, named or not. Value ops match ANY group Name for a positive
 * op and NONE for a negative one, the convention `material` and `parent`
 * already use.
 */

import { exactTypeName, RelationshipType } from '@ifc-lite/data';
import { expandTypes, type IfcDataStore } from '@ifc-lite/parser';
import type { ClassificationOp, TextKind } from './filter-rules.js';
import { matchStringAnyNone } from './filter-ops.js';

export interface GroupRule {
  kind: 'group';
  /** Only groups of this IFC class or a subclass, e.g. `IfcSystem`. Absent = any `IfcGroup`. */
  groupClass?: string;
  op: ClassificationOp;
  /** Matched against each group's Name. Ignored for `isSet` / `isNotSet`. */
  value: string;
  /** How `value` reads. Only consulted by the `matches` / `notMatches` ops. */
  valueKind?: TextKind;
}

export function groupRule(
  op: ClassificationOp,
  value: string,
  groupClass?: string,
  valueKind?: TextKind,
): GroupRule {
  return {
    kind: 'group',
    ...(groupClass ? { groupClass } : {}),
    op,
    value,
    ...(valueKind ? { valueKind } : {}),
  };
}

const classSetCache = new Map<string, ReadonlySet<string>>();

/** `groupClass` plus every subclass, upper-cased, for the store's schema. */
function classSet(groupClass: string, schemaVersion: string | undefined): ReadonlySet<string> {
  const key = `${schemaVersion ?? ''}|${groupClass.toUpperCase()}`;
  let set = classSetCache.get(key);
  if (!set) {
    set = new Set(expandTypes([groupClass], schemaVersion).map((t) => t.toUpperCase()));
    classSetCache.set(key, set);
  }
  return set;
}

/**
 * The groups `expressId` is assigned to (inverse `IfcRelAssignsToGroup`),
 * narrowed to `groupClass` when given. The exact declared class is read,
 * not the coalesced one, so a subclass check is a real subclass check.
 */
export function assignedGroupIds(store: IfcDataStore, expressId: number, groupClass?: string): number[] {
  if (!store.relationships) return [];
  const ids = store.relationships.getRelated(expressId, RelationshipType.AssignsToGroup, 'inverse');
  const wanted = groupClass?.trim();
  if (!wanted) return ids;
  const classes = classSet(wanted, store.schemaVersion);
  return ids.filter((id) => classes.has(exactTypeName(store.entities, id).toUpperCase()));
}

/** The Names of those groups; `undefined` for a group with no Name. */
export function assignedGroupNames(store: IfcDataStore, expressId: number, groupClass?: string): (string | undefined)[] {
  return assignedGroupIds(store, expressId, groupClass).map((id) => store.entities.getNameOrUndefined(id));
}

export function matchGroupRule(rule: GroupRule, store: IfcDataStore, expressId: number): boolean {
  const names = assignedGroupNames(store, expressId, rule.groupClass);
  if (rule.op === 'isSet') return names.length > 0;
  if (rule.op === 'isNotSet') return names.length === 0;
  return matchStringAnyNone(rule.op, names, rule.value, rule.valueKind);
}
