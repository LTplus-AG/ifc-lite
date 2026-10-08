/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Explicit system selectors must refer to actual native inputs (#7130). */
import type { FilterGroup } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';
import type { ArtifactProposal } from './proposal-kinds';
import { fieldSites } from './field-refs';
import { resolveFields } from './field-candidates';
import { modelSchemaIndex } from './model-schema';

function dependsOnClassification(proposal: ArtifactProposal): boolean {
  const has = (groups: readonly FilterGroup[]) => groups.some(group => group.rules.some(rule => rule.kind === 'classification'));
  switch (proposal.kind) {
    case 'filter.proposal': return has(proposal.groups);
    case 'list.proposal': return has(proposal.list.groups) || proposal.list.columns.some(column => column.source === 'classification');
    case 'lens.proposal': return proposal.lens.autoColor?.source === 'classification' || proposal.lens.rules.some(rule => has(rule.groups));
    case 'chart.proposal': return proposal.chart.elementField?.kind === 'classification' || proposal.chart.measureField?.kind === 'classification' || has(proposal.chart.filter?.groups ?? []);
  }
}

const CLASSIFICATION_TYPES = new Set(['IFCCLASSIFICATION', 'IFCCLASSIFICATIONREFERENCE', 'IFCRELASSOCIATESCLASSIFICATION', 'IFCRELDEFINESBYTYPE']);

/** Use current effective changes, never append-only history (undo leaves history). */
function hasUnsupportedClassificationEdits(state: ViewerState): boolean {
  for (const [id, model] of state.models) {
    const view = state.mutationViews.get(id);
    if (!view) continue;
    for (const change of view.getEffectiveChanges()) {
      const types = [model.ifcDataStore?.entities.getTypeName(change.entityId), view.getNewEntity(change.entityId)?.type, view.getEntityTypeMutation(change.entityId)?.newType];
      if (types.some(type => type !== undefined && CLASSIFICATION_TYPES.has(type.toUpperCase()))) return true;
    }
  }
  return false;
}

export async function groundClassificationSelectors(proposal: ArtifactProposal, state: ViewerState, signal?: AbortSignal): Promise<void> {
  if (!dependsOnClassification(proposal)) return;
  signal?.throwIfAborted();
  // TODO(remove-by: native effective classification evaluation #7131, owner: campaign #6812)
  if (hasUnsupportedClassificationEdits(state)) throw new Error('Native artifact classification evaluation cannot yet read these live classification edits; export and reload before reviewing this population');
  const sites = fieldSites(proposal).filter(site => site.kind === 'classification');
  if (sites.length === 0) return; // Omitted/empty/whitespace means native any-system.
  const resolutions = resolveFields(sites, await modelSchemaIndex(state, signal));
  const missing = resolutions.filter(result => result.status === 'unresolved');
  if (missing.length) throw new Error(`Classification system selector unresolved: ${missing.map(result => result.site.name).join(', ')}; choose an exact system from the loaded models`);
}
