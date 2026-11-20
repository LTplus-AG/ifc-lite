/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { modelCoordination, coordination, boolSchema } from './coordination-common';
import { isNativeWorkflowBusy } from '@/lib/flow/run-session';
interface CompareInput { head_model_id: string; scope: 'both' | 'data' | 'geometry'; excluded_types: string[]; match_by_content: boolean }
export const comparisonInputSchema = { type: 'object', properties: {
  head_model_id: { type: 'string', minLength: 1, maxLength: 200 }, scope: { type: 'string', enum: ['both', 'data', 'geometry'] },
  excluded_types: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } }, match_by_content: { type: 'boolean' },
}, required: ['head_model_id', 'scope', 'excluded_types', 'match_by_content'], additionalProperties: false } satisfies JSONSchemaType<CompareInput>;
export const coordinationCompareOperations = [
  coordination('compare.read', 'Read current native comparison configuration and report.', ['read'], emptySchema, () => {
    const s = useViewerStore.getState(); return { base_model_id: s.compareBaseModelId, head_model_id: s.compareHeadModelId,
      scope: s.compareScope, excluded_types: s.compareExcludedTypes, match_by_content: s.compareMatchByContent, running: s.compareRunning, error: s.compareError,
      result: s.compareResult ? { ...s.compareResult, comparedStores: undefined } : null };
  }),
  coordination('compare.showUnchanged', 'Set the native unchanged-entity overlay visibility channel.', ['view'], boolSchema, (i, c) => c.commit(() => { useViewerStore.getState().setCompareShowUnchanged(i.value); return { show_unchanged: useViewerStore.getState().compareShowUnchanged }; })),
  modelCoordination<CompareInput & { key_property: string }>('compare.run', 'Run and publish a parameterized native comparison, including authored IFC key selection, report and viewport overlay. Uses the same publish function as the UI and never accepts identity suggestions automatically.', ['configuration', 'view'], {
    type: 'object', properties: { head_model_id: { type: 'string', minLength: 1, maxLength: 200 }, scope: { type: 'string', enum: ['both', 'data', 'geometry'] }, excluded_types: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } }, match_by_content: { type: 'boolean' }, key_property: { type: 'string', maxLength: 500 } }, required: ['head_model_id', 'scope', 'excluded_types', 'match_by_content', 'key_property'], additionalProperties: false,
  }, async (i, c) => {
    const [{ prepareComparison }, { publishCompareResult, markUncachedCompareResult }] = await Promise.all([import('@/lib/compare/run-comparison'), import('@/lib/compare/publish-comparison')]);
    const initial = useViewerStore.getState(), base = initial.models.get(c.model.id), head = initial.models.get(i.head_model_id);
    if (!base || !head || initial.compareRunning) throw new Error('Load both models and wait for any native comparison to finish.');
    // The same refusals as the panel's Run button (useCompare.runComparison).
    if (isNativeWorkflowBusy()) throw new Error('A workflow is running; wait or cancel it.');
    if (base.id === head.id) throw new Error('Pick two different models to compare.');
    if (!base.ifcDataStore || !base.geometryResult || !head.ifcDataStore || !head.geometryResult) throw new Error('Both comparison models must be fully loaded.');
    const built = await prepareComparison({ baseModel: base, headModel: head, contentVersion: initial.geometryContentVersion, mutationVersion: initial.mutationVersion, getMutationView: initial.getMutationView, keyProperty: i.key_property || undefined, signal: c.signal });
    try {
      c.checkpoint?.(); const live = useViewerStore.getState();
      if (live.models.get(base.id) !== base || live.models.get(head.id) !== head || live.geometryContentVersion !== initial.geometryContentVersion || live.mutationVersion !== initial.mutationVersion || live.compareRunning) throw new Error('Comparison inputs changed during extraction.');
      // A clear or a newer comparison published during extraction outranks this run.
      if (live.compareResult !== initial.compareResult) throw new Error('The comparison was cleared or replaced during extraction.');
      return c.commit(() => {
        // Clearing first releases the panel's cached pair, so its option effect
        // cannot re-diff this result from fingerprints older than this run.
        if (live.compareResult) live.setCompareResult(null);
        live.setCompareBaseModelId(base.id); live.setCompareHeadModelId(head.id); live.setCompareKeyProperty(i.key_property || undefined); live.setCompareScope(i.scope); live.setCompareExcludedTypes(i.excluded_types); live.setCompareMatchByContent(i.match_by_content);
        const published = publishCompareResult(built); markUncachedCompareResult(useViewerStore.getState().compareResult);
        return { ...published.result, comparedStores: undefined };
      });
    } finally { built.dispose(); }
  }),
  modelCoordination<CompareInput & { key_property: string }>('compare.analyze', 'Compare the targeted base model with a loaded head model through the native fingerprint/diff service. Returns the terminal analysis without altering panel configuration or review decisions.', ['read'], {
    ...comparisonInputSchema, properties: { ...comparisonInputSchema.properties, key_property: { type: 'string', maxLength: 500 } },
    required: [...comparisonInputSchema.required, 'key_property'],
  }, async (input, c) => {
    const { prepareComparison, comparePreparedPair } = await import('@/lib/compare/run-comparison');
    const s = useViewerStore.getState(); const base = s.models.get(c.model.id), head = s.models.get(input.head_model_id);
    if (!base || !head) throw new Error('Both comparison models must be loaded.');
    const version = s.geometryContentVersion, mutation = s.mutationVersion;
    c.checkpoint?.();
    // The same authored key selection as compare.run, so both match entities alike.
    const built = await prepareComparison({ baseModel: base, headModel: head, contentVersion: version, mutationVersion: mutation, getMutationView: s.getMutationView, keyProperty: input.key_property || undefined, signal: c.signal });
    try {
      c.checkpoint?.(); const live = useViewerStore.getState();
      if (live.models.get(base.id) !== base || live.models.get(head.id) !== head || live.geometryContentVersion !== version || live.mutationVersion !== mutation) throw new Error('Comparison inputs changed; result discarded.');
      const result = comparePreparedPair(built, { scope: input.scope, excludedTypes: input.excluded_types, matchByContent: input.match_by_content });
      return { ...result, comparedStores: undefined };
    } finally { built.dispose(); }
  }),
];
