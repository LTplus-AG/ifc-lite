/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { evaluateLens, evaluateAutoColorLens, rgbaToHex, isGhostColor, type Lens, type AutoColorEvaluationResult, type LensEvaluationResult } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { createLensDataProvider } from './index';
import { evaluateLensGroups } from './evaluate-lens-groups';
import { customGroupingsFromLenses } from './custom-groupings';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '../model-tags/evaluator-models';
import { planLensHiddenSync } from '@/components/viewer/lens-visibility-ownership';
export function nativeLensGroupingSource(lens: Lens | null, savedLenses: readonly Lens[]) {
  return lens?.rules.some(rule => rule.groups?.some(group => group.rules.some(rule => rule.kind === 'customGrouping')))
    ? savedLenses : null;
}
function evaluationInputs(lens: Lens, state: ReturnType<typeof useViewerStore.getState>) {
  return { models: state.models, store: state.ifcDataStore, revision: state.mutationVersion,
    lensId: lens.id, definition: state.savedLenses.find(row => row.id === lens.id),
    groupings: nativeLensGroupingSource(lens, state.savedLenses), tags: state.modelTags, assignments: state.modelTagAssignments };
}
function inputsMatch(before: ReturnType<typeof evaluationInputs>, state: ReturnType<typeof useViewerStore.getState>) {
  return before.store === state.ifcDataStore && before.revision === state.mutationVersion
    && before.definition === state.savedLenses.find(row => row.id === before.lensId)
    && (!before.groupings || before.groupings === state.savedLenses) && before.tags === state.modelTags
    && before.assignments === state.modelTagAssignments
    && (before.models === state.models || (before.models.size === state.models.size
      && [...before.models].every(([id, model]) => {
        const live = state.models.get(id);
        return live && live.ifcDataStore === model.ifcDataStore && live.idOffset === model.idOffset;
      })));
}
type NativeLensEvaluation = {
  lensId: string;
  inputs: ReturnType<typeof evaluationInputs>;
  result: LensEvaluationResult | AutoColorEvaluationResult;
};
const evaluatedInputs = new WeakMap<Map<number, string>, Pick<NativeLensEvaluation, 'lensId' | 'inputs'>>();
export function hasCurrentNativeLensResult(state: ReturnType<typeof useViewerStore.getState>): boolean {
  const previous = evaluatedInputs.get(state.lensColorMap);
  return !!previous && previous.lensId === state.activeLensId && inputsMatch(previous.inputs, state);
}

export function clearLensOutput(): void {
  const state = useViewerStore.getState();
  state.setLensColorMap(new Map());
  state.setLensHiddenIds(new Set());
  state.setLensRuleCounts(new Map());
  state.setLensRuleEntityIds(new Map());
  state.setLensAutoColorLegend([]);
  state.setLensAppliedColors(null);
  state.setPendingColorUpdates(new Map());
}

export function applyNativeLensResult(activeLens: Lens, evaluation: NativeLensEvaluation): boolean {
      const state = useViewerStore.getState();
      const { lensId, inputs, result } = evaluation;
      if (lensId !== activeLens.id || lensId !== state.activeLensId || !inputsMatch(inputs, state)) return false;
      const { colorMap, hiddenIds, ruleCounts, ruleEntityIds } = result;

      // Build hex color map for UI legend (exclude ghost entries)
      const hexColorMap = new Map<number, string>();
      for (const [id, rgba] of colorMap) {
        if (!isGhostColor(rgba)) {
          hexColorMap.set(id, rgbaToHex(rgba));
        }
      }
      evaluatedInputs.set(hexColorMap, { lensId, inputs });
      useViewerStore.getState().setLensColorMap(hexColorMap);
      useViewerStore.getState().setLensHiddenIds(hiddenIds);
      useViewerStore.getState().setLensRuleCounts(ruleCounts);
      useViewerStore.getState().setLensRuleEntityIds(ruleEntityIds);

      // Store auto-color legend entries for UI display.
      useViewerStore.getState().setLensAutoColorLegend('legend' in result ? result.legend : []);

    // Apply colors via overlay system — original batches are never modified.
    // Remember the exact overlay so the compare overlay can restore it on
    // teardown instead of blanking the channel the lens still owns.
      useViewerStore.getState().setLensAppliedColors(colorMap.size > 0 ? colorMap : null);
      useViewerStore.getState().setPendingColorUpdates(colorMap);

      posthog.capture('lens_applied', {
        mode: activeLens.autoColor ? 'auto_color' : 'rules',
        rule_count: activeLens.rules.length,
        auto_color_source: activeLens.autoColor ? activeLens.autoColor?.source : undefined,
        matched_entity_count: colorMap.size,
        hidden_entity_count: hiddenIds.size,
      });
      return true;
}

export async function evaluateNativeLens(activeLens: Lens, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const state = useViewerStore.getState();
  const inputs = evaluationInputs(activeLens, state);
  const { models, ifcDataStore, mutationViews } = state;
  if (models.size === 0 && !ifcDataStore) throw new Error('No loaded model has lens data.');
  const provider = createLensDataProvider(models, ifcDataStore, mutationViews,
    globalId => useViewerStore.getState().resolveGlobalIdFromModels(globalId));
  if (activeLens.autoColor) return { lensId: activeLens.id, inputs, result: await evaluateAutoColorLens(activeLens.autoColor, provider, activeLens.capturedScope) };
  const evaluatorModels = models.size > 0 ? evaluatorModelsFromState(state)
    : [{ id: 'legacy', store: ifcDataStore, mutationView: mutationViews.get('legacy'), customGroupings: customGroupingsFromLenses(state.savedLenses, []) }];
  const matched = await evaluateLensGroups(activeLens, evaluatorModels, models, definedModelTagIdsOf(state), signal);
  signal?.throwIfAborted();
  return { lensId: activeLens.id, inputs, result: evaluateLens(activeLens, provider, matched) };
}

export function syncNativeLensHidden(): void {
  const state = useViewerStore.getState();
  const plan = planLensHiddenSync({ applied: state.lensAppliedHiddenIds, hiddenEntities: state.hiddenEntities,
    lensHiddenIds: state.activeLensId ? state.lensHiddenIds : new Set<number>() });
  if (plan.show.length > 0) state.showEntities(plan.show);
  if (plan.hide.length > 0) state.hideEntities(plan.hide);
  if (plan.nextApplied.length > 0 || state.lensAppliedHiddenIds.length > 0) state.setLensAppliedHiddenIds(plan.nextApplied);
}
