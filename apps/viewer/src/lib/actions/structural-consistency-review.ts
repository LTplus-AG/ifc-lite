/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a model that already has an analysis model disagrees with its
 * physical model (#10605): the checks `ifc-lite validate` runs
 * (`structuralConsistencyReport`, #9668), on the model as it stands now,
 * session edits included, so a derived member whose physical element moved
 * since derivation is reported (`structural-stale-item`, #10173).
 *
 * The checks read a parsed file, so an edited model is exported and parsed
 * again first (`materializeEffectiveIfcStore`); the export keeps every express
 * id, so each finding names an entity of the loaded model. The physical axes
 * come from the structural write path, loaded in its own chunk.
 */

import { extractStructuralOnDemand, structuralConsistencyReport, type StructuralConsistencyIssue, type StructuralConsistencyReport, type StructuralConsistencyRule } from '@ifc-lite/parser';
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
   * skipped, with the reason per rule (#10640). In IFC5 no axes are read at
   * all, so every linked member is skipped.
   */
  coverage: StructuralConsistencyReport['coverage'];
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
  const { issues: found, coverage } = structuralConsistencyReport(store, { physicalAxes });
  const issues = found
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => RULE_ORDER.indexOf(a.issue.rule) - RULE_ORDER.indexOf(b.issue.rule) || a.index - b.index)
    .map(({ issue }) => issue);
  const structural = extractStructuralOnDemand(store);
  const memberIdByGlobalId = new Map(structural.members.map((member) => [member.globalId, member.expressId]));
  const analysisModels = structural.analysisModels.map(({ expressId, name, itemGlobalIds }) => ({
    expressId, name,
    memberIds: itemGlobalIds.flatMap((globalId) => memberIdByGlobalId.get(globalId) ?? []),
  }));
  return { modelId, issues, analysisModels, coverage };
}
