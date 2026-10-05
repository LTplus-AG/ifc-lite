/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review continuity for an applied AI grouping across clash runs (P10). The
 * native resolver decides membership (exact occurrence first, durable review
 * key as fallback); this report only makes each outcome visible, so a rerun
 * never silently reassigns a finding.
 */

import type { Clash } from '@ifc-lite/clash';
import { manualClashOccurrenceKey, resolveManualClashGroups, type ManualClashGroup, type ManualClashMember } from './manual-groups';
import { occurrenceHash, type ClashGroupApplication } from './group-applications';

export interface ContinuityGroup {
  id: string;
  name: string;
  /** Members found at their exact occurrence. */
  unchanged: Clash[];
  /** Members found only through the durable review key: a different occurrence of the same pair. */
  reidentified: Clash[];
  /** Members with no finding in this run. Membership is retained, as for human groups. */
  gone: ManualClashMember[];
}

export interface ContinuityReport {
  groups: ContinuityGroup[];
  /** Applied groups since removed from the workspace (ungrouped or undone by hand). */
  missingGroups: number;
  /** Ungrouped findings absent from the run at apply; null when that run was too large to record. */
  newFindings: Clash[] | null;
  /** True when every applied member is unchanged and nothing new appeared. */
  unchanged: boolean;
}

export function applicationContinuity(
  receipt: ClashGroupApplication,
  workspaceGroups: readonly ManualClashGroup[],
  clashes: readonly Clash[],
): ContinuityReport {
  const applied = new Set(receipt.addedGroupIds);
  const resolved = new Map(resolveManualClashGroups(workspaceGroups, clashes).map(group => [group.definition.id, group]));
  const groups: ContinuityGroup[] = [];
  for (const definition of workspaceGroups) {
    if (!applied.has(definition.id)) continue;
    const match = resolved.get(definition.id);
    const found = new Set(match?.memberDefinitions ?? []);
    const unchanged: Clash[] = [], reidentified: Clash[] = [];
    match?.members.forEach((clash, index) => {
      (match.memberDefinitions[index].occurrenceKey === manualClashOccurrenceKey(clash) ? unchanged : reidentified).push(clash);
    });
    groups.push({ id: definition.id, name: definition.name, unchanged, reidentified,
      gone: definition.members.filter(member => !found.has(member)) });
  }
  let newFindings: Clash[] | null = null;
  if (receipt.population) {
    const before = new Set(receipt.population);
    const grouped = new Set([...resolved.values()].flatMap(group => group.members));
    newFindings = clashes.filter(clash => !grouped.has(clash) && !before.has(occurrenceHash(manualClashOccurrenceKey(clash))));
  }
  return { groups, missingGroups: applied.size - groups.length, newFindings,
    unchanged: groups.every(group => !group.reidentified.length && !group.gone.length) && newFindings?.length === 0 };
}
