/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The review's evidence: a proposal run through its own native engine against
 * the loaded models, before anything is saved. Every number here comes from
 * that engine (`evaluateFilterGroupsFederated`, `runListFederated`, the Lens
 * engine, Charts `aggregate`); this module only counts what came back, per
 * model, and states the denominators: how many rows carry a measured value and
 * how many do not, in which unit.
 */

import type { ViewerState } from '@/store';
import { evaluateFilterGroupsFederated, resolveCapturedEntityScope, type CapturedEntityScope, type FilteredElement } from '@ifc-lite/rules';
import { captureArtifactScope } from '@/lib/captured-artifact-scope';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import type { ArtifactProposal } from './proposal-kinds';
import type { FilterProposal } from './filter-proposal';
import { resolveModelNames } from './model-scope';
import { groundClassificationSelectors } from './classification-grounding';
import { previewList } from './preview-list';
import { previewLens } from './preview-lens';
import { previewChart } from './preview-chart';
import { populationOf, revisionOf, SAMPLE_LIMIT, type ArtifactPreview } from './preview-shared';

export type { ArtifactPreview, ModelPopulation, SampleRow, MeasureSummary, PreviewBucket, PreviewArtifact } from './preview-shared';
export { artifactScopeKey, isPreviewCurrent } from './preview-shared';

export async function previewFilterGroups(name: string, groups: FilterProposal['groups'], state: ViewerState, signal?: AbortSignal, capturedScope?: CapturedEntityScope): Promise<ArtifactPreview> {
  const matched: FilteredElement[] = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), groups, {
    limit: Number.POSITIVE_INFINITY, definedModelTagIds: definedModelTagIdsOf(state), signal,
    candidateExpressIdsByModel: capturedScope ? resolveCapturedEntityScope(capturedScope, evaluatorModelsFromState(state)) : undefined,
  });
  const modelName = (modelId: string) => state.models.get(modelId)?.name ?? modelId;
  return {
    kind: 'filter.proposal', matched: matched.length, population: populationOf(matched, state), sampleColumns: [],
    samples: matched.slice(0, SAMPLE_LIMIT).map((row) => ({ model: modelName(row.modelId), ifcClass: row.ifcType, name: row.name, globalId: row.globalId, values: [] })),
    measures: [], buckets: [], artifact: { kind: 'filter.proposal', name, groups, ...(capturedScope ? { capturedScope } : {}) }, revision: revisionOf(state),
  };
}

/** Run `proposal` through its native engine against `state`. Throws the engine's own refusal. */
export async function previewArtifact(answer: ArtifactProposal, state: ViewerState, signal?: AbortSignal, pinnedScope?: CapturedEntityScope): Promise<ArtifactPreview> {
  // Model names become fingerprints first, so no engine ever sees a name it would silently match nothing with.
  const proposal = resolveModelNames(answer, state.models);
  const captured = proposal.kind !== 'chart.proposal' && proposal.scope && proposal.scope !== 'all'
    ? pinnedScope ?? captureArtifactScope(proposal.scope, state) : undefined;
  await groundClassificationSelectors(proposal, state, signal);
  switch (proposal.kind) {
    case 'filter.proposal': return previewFilterGroups(proposal.name, proposal.groups, state, signal, captured);
    case 'list.proposal': return previewList(proposal, state, signal, captured);
    case 'lens.proposal': return previewLens(proposal, state, signal, captured);
    case 'chart.proposal': return previewChart(proposal, state, signal);
  }
}
