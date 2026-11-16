/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { coordination } from './coordination-common';
interface CompareInput { head_model_id: string; scope: 'both' | 'data' | 'geometry'; excluded_types: string[]; match_by_content: boolean }
const schema: JSONSchemaType<CompareInput> = { type: 'object', properties: {
  head_model_id: { type: 'string', minLength: 1, maxLength: 200 }, scope: { type: 'string', enum: ['both', 'data', 'geometry'] },
  excluded_types: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 200 } }, match_by_content: { type: 'boolean' },
}, required: ['head_model_id', 'scope', 'excluded_types', 'match_by_content'], additionalProperties: false };
export const coordinationCompareOperations = [
  coordination('compare.read', 'Read current native comparison configuration and report.', ['read'], emptySchema, () => {
    const s = useViewerStore.getState(); return { base_model_id: s.compareBaseModelId, head_model_id: s.compareHeadModelId,
      scope: s.compareScope, excluded_types: s.compareExcludedTypes, match_by_content: s.compareMatchByContent, running: s.compareRunning, error: s.compareError,
      result: s.compareResult ? { ...s.compareResult, comparedStores: undefined } : null };
  }),
  coordination('compare.analyze', 'Compare the targeted base model with a loaded head model through the native fingerprint/diff service. Returns the terminal analysis without altering panel configuration or review decisions.', ['read'], schema, async (input, c) => {
    const { prepareComparison, comparePreparedPair } = await import('@/lib/compare/run-comparison');
    const s = useViewerStore.getState(); const base = s.models.get(c.model.id), head = s.models.get(input.head_model_id);
    if (!base || !head) throw new Error('Both comparison models must be loaded.');
    const version = s.geometryContentVersion, mutation = s.mutationVersion;
    c.checkpoint?.();
    const built = await prepareComparison({ baseModel: base, headModel: head, contentVersion: version, mutationVersion: mutation, getMutationView: s.getMutationView, signal: c.signal });
    try {
      c.checkpoint?.(); const live = useViewerStore.getState();
      if (live.models.get(base.id) !== base || live.models.get(head.id) !== head || live.geometryContentVersion !== version || live.mutationVersion !== mutation) throw new Error('Comparison inputs changed; result discarded.');
      const result = comparePreparedPair(built, { scope: input.scope, excludedTypes: input.excluded_types, matchByContent: input.match_by_content });
      return { ...result, comparedStores: undefined };
    } finally { built.dispose(); }
  }),
];
