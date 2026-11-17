/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a model that already has an analysis model disagrees with its
 * physical model (#10605): the checks `ifc-lite validate` runs
 * (`structuralConsistencyIssues`, #9668), on the model as it stands now,
 * session edits included, so a derived member whose physical element moved
 * since derivation is reported (`structural-stale-item`, #10173).
 *
 * The checks read a parsed file, so an edited model is exported and parsed
 * again first (`materializeEffectiveIfcStore`); the export keeps every express
 * id, so each finding names an entity of the loaded model. The physical axes
 * come from the structural write path, loaded in its own chunk.
 */

import { extractStructuralOnDemand, getInheritanceChainAcrossSchemas, structuralConsistencyIssues, structuralCounterparts, type StructuralConsistencyIssue, type StructuralConsistencyRule, type StructuralExtraction, type StructuralLine } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { loadStructuralWrites } from '@/sdk/adapters/store-adapter-structural';
import { materializeEffectiveIfcStore } from '@/lib/effective-ifc-store';

export interface StructuralConsistencyReview {
  modelId: string;
  /** Findings, the ones about a moved or drifted physical element first. */
  issues: StructuralConsistencyIssue[];
  /** Each analysis model, with the members assigned to it, by model-local express id. */
  analysisModels: Array<{ expressId: number; name?: string; memberIds: number[] }>;
  /**
   * The linked curve members, and those the movement and axis-drift rules
   * skipped because no axis was read for any of their elements: the element's
   * shape could not be read or its class has no axis rule. In IFC5 no axes are
   * read at all, so every linked member is skipped.
   */
  axisCoverage: { linked: number; skipped: Array<{ memberId: number; elementIds: readonly number[] }> };
}

/**
 * The rules' own condition (`structuralConsistencyIssues`): a curve member is
 * compared when one of its linked elements has a readable axis. The parser
 * skips the rest without saying so.
 */
function axisCoverage(structural: StructuralExtraction, physicalAxes: ReadonlyMap<number, StructuralLine> | undefined): StructuralConsistencyReview['axisCoverage'] {
  const coverage: StructuralConsistencyReview['axisCoverage'] = { linked: 0, skipped: [] };
  for (const member of structural.members) {
    if (!getInheritanceChainAcrossSchemas(member.type).includes('IfcStructuralCurveMember')) continue;
    const elementIds = structuralCounterparts(structural, member.expressId)?.expressIds ?? [];
    if (elementIds.length === 0) continue;
    coverage.linked++;
    if (!physicalAxes || !elementIds.some((id) => physicalAxes.has(id))) coverage.skipped.push({ memberId: member.expressId, elementIds });
  }
  return coverage;
}

/** Findings about the physical element having moved lead: they are why a derived model goes out of date. */
const RULE_ORDER: readonly StructuralConsistencyRule[] = [
  'structural-stale-item', 'structural-axis-drift', 'structural-class-mismatch',
  'structural-unlinked-item', 'structural-unconnected-member', 'structural-unlinked-element',
];

export async function reviewStructuralConsistency(state: Pick<ViewerState, 'models' | 'mutationViews'>, modelId: string): Promise<StructuralConsistencyReview> {
  const model = state.models.get(modelId);
  const dataStore = model?.ifcDataStore;
  if (!model || !dataStore) throw new Error('The loaded model is unavailable');
  const [{ structuralPhysicalAxes }, store] = await Promise.all([
    loadStructuralWrites(),
    materializeEffectiveIfcStore(dataStore, state.mutationViews.get(modelId) ?? null, model.schemaVersion),
  ]);
  // The axes read every curve element's shape; IFC5 has no reader for them, and its other rules still run.
  const physicalAxes = store.schemaVersion === 'IFC5' ? undefined : structuralPhysicalAxes(store);
  const issues = structuralConsistencyIssues(store, { physicalAxes })
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => RULE_ORDER.indexOf(a.issue.rule) - RULE_ORDER.indexOf(b.issue.rule) || a.index - b.index)
    .map(({ issue }) => issue);
  const structural = extractStructuralOnDemand(store);
  const memberIdByGlobalId = new Map(structural.members.map((member) => [member.globalId, member.expressId]));
  const analysisModels = structural.analysisModels.map(({ expressId, name, itemGlobalIds }) => ({
    expressId, name,
    memberIds: itemGlobalIds.flatMap((globalId) => memberIdByGlobalId.get(globalId) ?? []),
  }));
  return { modelId, issues, analysisModels, axisCoverage: axisCoverage(structural, physicalAxes) };
}
