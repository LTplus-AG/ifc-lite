/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens review: the same evaluation `useLens` applies, without touching the
 * scene. Rule lenses resolve each rule's groups through the shared federated
 * evaluator (`evaluateLensGroups`), then the Lens engine applies first-match
 * order, so a rule's count is what it would colour, not what it matches in
 * isolation. Auto-colour lenses report the engine's own legend, whose bucket
 * counts may overlap (a layered element joins each of its materials); the
 * matched count is distinct elements. Elements the lens leaves uncoloured are
 * counted as the denominator's remainder.
 */

import { evaluateAutoColorLens, evaluateLens, type Lens } from '@ifc-lite/lens';
import type { CapturedEntityScope } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';
import { createLensDataProvider } from '@/lib/lens';
import { evaluateLensGroups } from '@/lib/lens/evaluate-lens-groups';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import type { LensProposal } from './lens-proposal';
import { populationOf, revisionOf, type ArtifactPreview, type PreviewBucket } from './preview-shared';

export async function previewLens(proposal: LensProposal, state: ViewerState, signal?: AbortSignal, capturedScope?: CapturedEntityScope): Promise<ArtifactPreview> {
  const id = `lens-${crypto.randomUUID()}`;
  const { name, rules, autoColor } = proposal.lens;
  const lens: Lens = autoColor ? { id, name, rules: [], autoColor } : { id, name, rules };
  if (capturedScope) lens.capturedScope = capturedScope;
  const provider = createLensDataProvider(state.models, state.ifcDataStore, state.mutationViews, (globalId) => state.resolveGlobalIdFromModels(globalId));
  let colored: number[];
  let buckets: PreviewBucket[];
  let considered: number;
  if (lens.autoColor) {
    const result = evaluateAutoColorLens(lens.autoColor, provider, lens.capturedScope);
    buckets = result.legend.map((entry) => ({ label: entry.name, count: entry.count, color: entry.color, ...(entry.isAbsent ? { absence: true } : {}) }));
    const absent = new Set(result.legend.filter((entry) => entry.isAbsent).map((entry) => entry.id));
    // A multi-material element is in each of its materials' buckets but coloured once (the engine's first group wins).
    colored = [...new Set([...result.ruleEntityIds].filter(([id]) => !absent.has(id)).flatMap(([, ids]) => ids))];
    considered = result.colorMap.size;
  } else {
    const matched = await evaluateLensGroups(lens, evaluatorModelsFromState(state), state.models, definedModelTagIdsOf(state), signal);
    const result = evaluateLens(lens, provider, matched);
    buckets = lens.rules.map((rule) => ({ label: rule.name, count: result.ruleCounts.get(rule.id) ?? 0, color: rule.action === 'hide' ? undefined : rule.color }));
    colored = [...result.ruleEntityIds.values()].flat();
    considered = result.colorMap.size + result.hiddenIds.size;
  }
  const refs = colored.flatMap((globalId) => {
    const ref = state.resolveGlobalIdFromModels(globalId);
    return ref ? [{ modelId: ref.modelId }] : [];
  });
  return {
    kind: 'lens.proposal', matched: colored.length, population: populationOf(refs, state), sampleColumns: [], samples: [],
    measures: [], buckets, unassigned: Math.max(0, considered - colored.length),
    artifact: { kind: 'lens.proposal', lens }, revision: revisionOf(state),
  };
}
