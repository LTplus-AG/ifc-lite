/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Panel sections for a duplicate-scan result: one section per coincident SET
 * (#2530 review blocker).
 *
 * `findDuplicates` is pairwise, so N coincident copies arrive as N(N−1)/2
 * clashes and the panel's generic severity/rule/typePair sections rendered all
 * of them as sibling rows, each object named N−1 times — the exact complaint
 * `groupDuplicateSets` exists to answer. `useClash.runDuplicates` stores that
 * grouping in `clashGroups`; this maps it onto the panel's section shape, so a
 * triplicated column reads as ONE "3 coincident IfcColumn objects" section
 * whose member pair rows sit inside it (collapsible, still focusable
 * individually).
 *
 * Pure and defensive: it returns `null` — caller falls back to the generic
 * `groupBy` sections — unless the result is a duplicates-only run AND `groups`
 * covers every visible clash. `clashGroups` is written in the same store
 * update as `clashResult`, but a mismatch (a stale grouping from an earlier
 * run) must degrade to the pairwise list, never mislabel it.
 */

import { DUPLICATES_RULE, type Clash, type ClashGroup, type ClashResult, type ClashSeverity } from '@ifc-lite/clash';

export interface DuplicateSetSection {
  /** Stable section key (the group id). */
  key: string;
  /** Group title, e.g. "3 coincident IfcColumn objects". */
  label: string;
  /** Set severity (most severe member) — the caller maps it to a colour. */
  severity: ClashSeverity;
  /** The set's member pairs, in the caller's (filtered, sorted) order. */
  items: Clash[];
}

export function duplicateSetSections(
  result: ClashResult | null,
  groups: ClashGroup[] | null,
  visibleClashes: readonly Clash[],
): DuplicateSetSection[] | null {
  if (!result || !groups || groups.length === 0) return null;
  // Only a duplicates-only run: a discipline run's cluster groups are a BCF
  // unit, not a reading of coincidence, and mixed results keep the generic
  // sections.
  if (result.rulesRun.length !== 1 || result.rulesRun[0].id !== DUPLICATES_RULE.id) return null;

  const groupOfClash = new Map<string, ClashGroup>();
  for (const group of groups) {
    for (const member of group.members) groupOfClash.set(member.id, group);
  }

  const itemsOfGroup = new Map<string, Clash[]>();
  for (const clash of visibleClashes) {
    const group = groupOfClash.get(clash.id);
    if (!group) return null; // stale grouping — degrade to the generic sections
    const items = itemsOfGroup.get(group.id);
    if (items) items.push(clash);
    else itemsOfGroup.set(group.id, [clash]);
  }

  // Section order follows the groups' own order (severity, then set size desc)
  // rather than re-sorting; sets emptied by the touch/status filters drop out.
  const sections: DuplicateSetSection[] = [];
  for (const group of groups) {
    const items = itemsOfGroup.get(group.id);
    if (!items) continue;
    sections.push({ key: group.id, label: group.title, severity: group.severity, items });
  }
  return sections;
}
