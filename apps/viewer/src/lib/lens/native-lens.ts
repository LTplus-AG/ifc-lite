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
function evaluationInputs(state: ReturnType<typeof useViewerStore.getState>) {
  return [state.activeLensId, state.models, state.ifcDataStore, state.mutationVersion,
    state.savedLenses, state.modelTags, state.modelTagAssignments] as const;
}
const evaluatedInputs = new WeakMap<Map<number, string>, ReturnType<typeof evaluationInputs>>();
export function hasCurrentNativeLensResult(state: ReturnType<typeof useViewerStore.getState>): boolean {
  const previous = evaluatedInputs.get(state.lensColorMap);
  return !!previous && evaluationInputs(state).every((value, i) => value === previous[i]);
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

export function applyNativeLensResult(activeLens: Lens, result: LensEvaluationResult | AutoColorEvaluationResult): void {
      const { colorMap, hiddenIds, ruleCounts, ruleEntityIds } = result;

      // Build hex color map for UI legend (exclude ghost entries)
      const hexColorMap = new Map<number, string>();
      for (const [id, rgba] of colorMap) {
        if (!isGhostColor(rgba)) {
          hexColorMap.set(id, rgbaToHex(rgba));
        }
      }
      evaluatedInputs.set(hexColorMap, evaluationInputs(useViewerStore.getState()));
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
}

export async function evaluateNativeLens(activeLens: Lens, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const state = useViewerStore.getState();
  const { models, ifcDataStore, mutationViews } = state;
  if (models.size === 0 && !ifcDataStore) throw new Error('No loaded model has lens data.');
  const provider = createLensDataProvider(models, ifcDataStore, mutationViews,
    globalId => useViewerStore.getState().resolveGlobalIdFromModels(globalId));
  if (activeLens.autoColor) return evaluateAutoColorLens(activeLens.autoColor, provider, activeLens.capturedScope);
  const evaluatorModels = models.size > 0 ? evaluatorModelsFromState(state)
    : [{ id: 'legacy', store: ifcDataStore, mutationView: mutationViews.get('legacy'), customGroupings: customGroupingsFromLenses(state.savedLenses, []) }];
  const matched = await evaluateLensGroups(activeLens, evaluatorModels, models, definedModelTagIdsOf(state), signal);
  signal?.throwIfAborted();
  return evaluateLens(activeLens, provider, matched);
}

export function syncNativeLensHidden(): void {
  const state = useViewerStore.getState();
  const plan = planLensHiddenSync({ applied: state.lensAppliedHiddenIds, hiddenEntities: state.hiddenEntities,
    lensHiddenIds: state.activeLensId ? state.lensHiddenIds : new Set<number>() });
  if (plan.show.length > 0) state.showEntities(plan.show);
  if (plan.hide.length > 0) state.hideEntities(plan.hide);
  if (plan.nextApplied.length > 0 || state.lensAppliedHiddenIds.length > 0) state.setLensAppliedHiddenIds(plan.nextApplied);
}
