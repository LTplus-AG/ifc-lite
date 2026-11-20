/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { collectChangedModels } from '@/lib/export/model-changes';
import { resolveRef } from '../refs';
import { operation, viewerOperation, emptySchema, referenceSchema } from './contract';
import { unavailable } from './refusals';

const basketSchema = { type: 'object', properties: {
  refs: { type: 'array', items: { type: 'string' } }, hierarchy_refs: { type: 'array', items: { type: 'string' } },
  total: { type: 'integer' }, hierarchy_total: { type: 'integer' },
}, required: ['refs', 'hierarchy_refs', 'total', 'hierarchy_total'], additionalProperties: false };
function basket() {
  const s = useViewerStore.getState();
  return { refs: [...s.pinboardEntities].slice(0, 1000), hierarchy_refs: [...s.hierarchyBasketSelection].slice(0, 1000),
    total: s.pinboardEntities.size, hierarchy_total: s.hierarchyBasketSelection.size };
}
const metadata = (id: string, description: string) => ({ id, owner: 'hierarchy', description,
  effects: ['view'] as const, capability: 'commands-and-edits' as const, implementation: 'native-store' as const,
  synchronous: true, outputSchema: basketSchema });
const appliedSchema = { type: 'object', properties: { applied: { type: 'boolean' } }, required: ['applied'], additionalProperties: false };
function requireFederatedModel(id: string) {
  if (!useViewerStore.getState().models.has(id)) throw unavailable('This native model action requires a federated model entry.');
}
const actions = [
  ['basket.replace', 'Replace basket and native isolation, preserving visibility ownership.', 'setBasket'],
  ['basket.add', 'Add validated entities to basket and update native isolation.', 'addToBasket'],
  ['basket.remove', 'Remove validated entities from basket and update native isolation.', 'removeFromBasket'],
  ['basket.hierarchySource', 'Set the hierarchy-derived basket source to validated model entities.', 'setHierarchyBasketSelection'],
] as const;
export const hierarchyOperations = [
  viewerOperation({ ...metadata('basket.read', 'Read up to the first 1000 native basket and hierarchy-source refs with exact total counts.'), effects: ['read'], capability: 'read' }, emptySchema, basket),
  ...actions.map(([id, description, action]) => operation(metadata(id, description), referenceSchema, (i, c) => {
    const refs = i.express_ids.map(express_id => resolveRef(c.model, { express_id }));
    useViewerStore.getState()[action](refs); return basket();
  })),
  viewerOperation(metadata('basket.clear', 'Clear native basket and its owned isolation.'), emptySchema, () => {
    useViewerStore.getState().clearBasket(); return basket();
  }),
  viewerOperation(metadata('basket.show', 'Restore native isolation from the existing basket.'), emptySchema, () => {
    useViewerStore.getState().showPinboard(); return basket();
  }),
  operation({ ...metadata('model.activate', 'Activate the explicit model using the native model switch action.'), outputSchema: appliedSchema }, emptySchema, (_, c) => {
    requireFederatedModel(c.model.id); useViewerStore.getState().setActiveModel(c.model.id); return { applied: true };
  }),
  operation({ ...metadata('model.unload', 'Unload the explicit model through native teardown only when it has no unexported changes. Native discard confirmation remains required for edited models.'), outputSchema: appliedSchema }, emptySchema, (_, c) => {
    requireFederatedModel(c.model.id);
    if (collectChangedModels(useViewerStore.getState()).models.some(model => model.id === c.model.id)) {
      throw unavailable('This model has unexported changes. Use the native discard confirmation before removing it.');
    }
    useViewerStore.getState().removeModel(c.model.id); return { applied: true };
  }),
  operation<{ visible: boolean }>({ ...metadata('model.visibility', 'Set whole-model native visibility for the explicit model.'), outputSchema: appliedSchema }, {
    type: 'object', properties: { visible: { type: 'boolean' } }, required: ['visible'], additionalProperties: false,
  }, (i, c) => { requireFederatedModel(c.model.id); useViewerStore.getState().setModelVisibility(c.model.id, i.visible); return { applied: true }; }),
  viewerOperation<{ mode: 'spatial' | 'type' | 'ifc-type' | 'material' | 'groups' | 'presentation-layers' }>({ ...metadata('hierarchy.mode', 'Set the native hierarchy grouping; domain tree traversal remains available through hierarchy.tree.'), outputSchema: appliedSchema }, {
    type: 'object', properties: { mode: { type: 'string', enum: ['spatial', 'type', 'ifc-type', 'material', 'groups', 'presentation-layers'] } }, required: ['mode'], additionalProperties: false,
  }, i => { useViewerStore.getState().setHierarchyMode(i.mode); return { applied: true }; }),
];
