/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7089: saved grouping decisions are records, never evidence of clash resolution. */
import { clashReviewKey, type ClashResult } from '@ifc-lite/clash';
import type { ClashGroupApplication } from '../../clash/group-applications';
import type { ClashGroupWorkspace } from '../../clash/group-workspace';
import { applicationContinuity } from '../../clash/group-continuity';
import { manualClashOccurrenceKey, resolveManualClashGroups } from '../../clash/manual-groups';
import type { FindingElement, FindingRun, FindingSourceResult, ReviewModel } from '../types';
import { clashGlobalId } from './clash';
import { typeDisciplines } from './disciplines';

export function groupReceiptFindings(receipts: readonly ClashGroupApplication[], workspaces: readonly ClashGroupWorkspace[],
  current: { result: ClashResult; stale: boolean } | null, models: readonly ReviewModel[]): FindingSourceResult {
  const names = new Map(models.map(model => [model.id, model.name]));
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));
  const clashes = current?.result.clashes ?? [];
  const occurrences = new Map<string, number>(), identities = new Map<string, number>();
  for (const clash of clashes) {
    const occurrence = manualClashOccurrenceKey(clash), identity = clashReviewKey(clash);
    occurrences.set(occurrence, (occurrences.get(occurrence) ?? 0) + 1);
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  const result: FindingSourceResult = { runs: [], findings: [] };
  for (const receipt of receipts) {
    const workspace = workspaceById.get(receipt.workspaceId);
    const continuity = receipt.status === 'applied' && workspace && current && !current.stale
      ? applicationContinuity(receipt, workspace.groups, clashes) : null;
    // The immutable receipt partition supplies original membership, including removed or undone groups.
    const savedGroups = receipt.after.groups.filter(group => receipt.addedGroupIds.includes(group.id));
    const resolved = new Map(resolveManualClashGroups(savedGroups, clashes).map(group => [group.definition.id, group]));
    const run: FindingRun = { id: JSON.stringify(['clash-group-application', receipt.id]), source: 'clash', temporal: 'historical',
      label: receipt.workspaceName, capturedAt: receipt.createdAt, complete: false,
      incomplete: [{ code: 'partial-source', detail: 'A saved grouping receipt is not a detection run' },
        ...(receipt.partial || receipt.source === 'sample' ? [{ code: 'partial-source' as const, detail: `${receipt.source}; partial=${receipt.partial}` }] : []),
        ...(current?.stale ? [{ code: 'stale' as const }] : [])], models: [] };
    result.runs.push(run);
    for (const group of savedGroups) {
      const matches = resolved.get(group.id);
      const ambiguous = matches?.memberDefinitions.some((member, index) => {
        const clash = matches.members[index];
        return member.occurrenceKey === manualClashOccurrenceKey(clash)
          ? occurrences.get(member.occurrenceKey) !== 1 : identities.get(member.reviewKey) !== 1;
      }) ?? false;
      const usable = !current?.stale && !!current && !ambiguous && matches?.members.length === group.members.length;
      const elements: FindingElement[] = usable ? matches.members.flatMap(clash => [clash.a, clash.b].map(ref => ({
        globalId: clashGlobalId(ref), modelId: ref.model, modelName: names.get(ref.model) ?? null, ifcType: ref.tag,
        ...(ref.name ? { name: ref.name } : {}),
      }))) : [];
      const live = continuity?.groups.find(candidate => candidate.id === group.id);
      result.findings.push({ id: JSON.stringify([run.id, group.id]), lineage: JSON.stringify(['clash-group-application', receipt.id, group.id]),
        source: 'clash', run, elements, nativeStatus: receipt.status, title: group.name, lifecycle: 'record',
        detail: [`workspace ${receipt.workspaceName}; revision ${receipt.baseRevision} → ${receipt.appliedRevision}`,
          `origin ${receipt.origin}; source ${receipt.source}; partial=${receipt.partial}; moved ${receipt.movedFindings}`,
          `saved members ${group.members.length}`,
          ...(receipt.undoneAt ? [`undone ${receipt.undoneAt}`] : []),
          ...(live ? [`native continuity: unchanged ${live.unchanged.length}; reidentified ${live.reidentified.length}; gone ${live.gone.length}`] : ['Native continuity unavailable']),
          ...(continuity ? [`missing groups ${continuity.missingGroups}; new findings ${continuity.newFindings?.length ?? 'unknown'}`] : []),
          ...(!usable ? [ambiguous ? 'Native membership ambiguous' : 'Native membership unavailable or incomplete'] : [])],
        disciplines: [...new Set(elements.flatMap(element => element.ifcType ? typeDisciplines(element.ifcType) : []))], storeys: [],
        evidence: { kind: 'clash-group-application', applicationId: receipt.id, groupId: group.id },
      });
    }
  }
  return result;
}
