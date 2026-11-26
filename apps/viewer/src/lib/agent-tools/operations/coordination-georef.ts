/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation, emptySchema } from './contract';
import { coordinationOutputSchema } from './coordination-outputs';
import { invalidInput, stale, unavailable } from './refusals';
const metadata = (id: string, description: string) => ({ id, owner: 'properties', description, effects: ['read'] as const, capability: 'read' as const, implementation: 'native-store' as const, outputSchema: coordinationOutputSchema(id) });
export const coordinationGeorefOperations = [
  viewerOperation<{ query: string }>(metadata('georeference.lookupEpsg', 'Search code prefixes or names through the exact native offline EPSG index and viewer starter-code preference. This current control performs no external network lookup.'), {
    type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false,
  }, async (i, c) => {
    // A blank query would come back as an empty result, indistinguishable from a search with no match.
    if (!i.query.trim()) throw invalidInput('invalid-value', 'An EPSG code or name to search for is required.');
    const { searchViewerEpsg } = await import('@/components/viewer/properties/epsg-search'); return { results: await searchViewerEpsg(i.query, c.signal) };
  }),
  viewerOperation(metadata('georeference.realignmentState', 'Inspect exact federation sources and revisions needed for a guarded native Re-align reload.'), emptySchema, () => {
    const s = useViewerStore.getState(); return { model_ids: [...s.models.keys()].sort(), mutation_version: s.mutationVersion, geometry_version: s.geometryContentVersion,
      sources: [...s.models.values()].map(model => ({ model_id: model.id, name: model.name, source_available: !!model.sourceFile })) };
  }),
  viewerOperation<{ expected_model_ids: string[]; expected_mutation_version: number; expected_geometry_version: number }>({ ...metadata('georeference.realign', 'Re-align by draining every retained source through the native federation addModel wrapper and canonical loader. Refuses missing sources or a pending model load before clearing; it reports partial failures and stops if a new primary replaces the federation.'), effects: ['configuration', 'view', 'network'], capability: 'commands-and-edits', policy: { network: 'native-provider' } }, {
    type: 'object', properties: { expected_model_ids: { type: 'array', minItems: 2, maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } }, expected_mutation_version: { type: 'integer', minimum: 0 }, expected_geometry_version: { type: 'integer', minimum: 0 } }, required: ['expected_model_ids', 'expected_mutation_version', 'expected_geometry_version'], additionalProperties: false,
  }, async (i, c) => {
    const [{ realignLoadedModels }, { coordinationModelAdder }, { isNativeWorkflowBusy }, { isModelLoadPending }] = await Promise.all([import('@/lib/geo/realign-loaded-models'), import('@/services/coordination-loader'), import('@/lib/flow/run-session'), import('@/hooks/modelLoadCanceller')]);
    // Re-align reloads every model from its source file, so unexported edits and undo history would be lost.
    const { collectChangedModels, totalChangeCount } = await import('@/lib/export/model-changes');
    if (totalChangeCount(collectChangedModels(useViewerStore.getState())) > 0) throw unavailable('Re-align reloads models from their source files; export or discard the unexported edits first.');
    return c.commitAsync(() => {
      const s = useViewerStore.getState(); if (JSON.stringify([...s.models.keys()].sort()) !== JSON.stringify([...i.expected_model_ids].sort()) || s.mutationVersion !== i.expected_mutation_version || s.geometryContentVersion !== i.expected_geometry_version) throw stale('Federation sources or revisions changed; inspect before realigning.');
      if (isNativeWorkflowBusy()) throw unavailable('A workflow is running; wait or cancel it before realigning.');
      if (isModelLoadPending()) throw unavailable('A model is loading; wait for it to finish before realigning.');
      return realignLoadedModels(coordinationModelAdder());
    });
  }),
];
