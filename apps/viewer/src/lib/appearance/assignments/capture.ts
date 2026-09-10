/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view.js';
import { computeFullSourceHash } from '@/utils/sourceContentHash.js';
import { appearanceAssets } from '../model-assets.js';
import { appearanceOwners, appearanceScope } from '../scope.js';
import { prepareAppearanceSnapshot, type AppearanceSnapshot } from '../snapshot.js';
import type { AppearancePlanner } from '../planner-worker-client.js';
import type { AppearanceDraftSettings, AppearanceScope, AppearanceSourceOption } from '../draft-types.js';
import type { AppearanceAssignment, AssignmentQuery } from './types.js';
import { resolveAppearanceAssignments } from './resolve.js';
import { ownAssignmentSource } from './source.js';

function logicalSource(source: AppearanceSourceOption): AppearanceAssignment['source'] {
  return ownAssignmentSource(source);
}

/** Use effective IFC identity, including overlay-created objects and GUID edits.
 * Local IDs come exclusively from the canonical per-model scope catalog. */
export function assignmentProductGlobalId(snapshot: AppearanceSnapshot, id: number): string {
  const state = useViewerStore.getState(), model = state.models.get(snapshot.modelId);
  const view = state.mutationViews.get(snapshot.modelId), positional = view?.getPositionalMutationsForEntity(id);
  const guid = positional?.has(0) ? positional.get(0)
    : view?.getAttributeMutationsForEntity(id).find(attribute => attribute.name === 'GlobalId')?.value
      ?? view?.getNewEntity(id)?.attributes[0] ?? model?.ifcDataStore?.entities.getGlobalId(id);
  if (typeof guid !== 'string' || !guid) throw new Error(`Object #${id} needs a stable IFC GlobalId before saving an assignment.`);
  return guid;
}

export interface CapturedAssignment {
  assignment: AppearanceAssignment;
  snapshot: AppearanceSnapshot;
  validate(): void;
}

/** Capture one reviewed row without changing IFC, renderer or history. The caller
 * owns the planner and source inventory lease; pending work remains cancellable. */
export async function captureAppearanceAssignment(options: {
  modelId: string; slotId: string; sourceId: string;
  scope: AppearanceScope; settings: AppearanceDraftSettings;
  planner: AppearancePlanner; signal: AbortSignal;
  previousSnapshot?: AppearanceSnapshot;
}): Promise<CapturedAssignment> {
  const { modelId, signal } = options;
  const initial = useViewerStore.getState(), model = initial.models.get(modelId);
  const source = initial.appearanceSources.find(item => item.id === options.sourceId);
  if (initial.collabRoomId) throw new Error('Leave the shared room before preparing assignments.');
  if (!model?.ifcDataStore || model.loadState && model.loadState !== 'complete') throw new Error('Choose a fully loaded IFC model.');
  if (!source || !appearanceAssets.get(source.assetId ?? source.id)) throw new Error('The assignment image is unavailable. Restore its source first.');
  const frozenSource = logicalSource(source), sourceKey = JSON.stringify(frozenSource);
  const settings = structuredClone(options.settings), scope = structuredClone(options.scope);
  getOrCreateMutationView(useViewerStore, modelId);
  const owners = appearanceOwners(useViewerStore.getState(), modelId);
  const snapshot = await prepareAppearanceSnapshot(options.previousSnapshot ?? null, modelId, owners.productIds, options.planner, signal);
  const validate = () => {
    if (signal.aborted) throw new DOMException('Assignment preparation was cancelled.', 'AbortError');
    snapshot.validate();
    const state = useViewerStore.getState(), currentSource = state.appearanceSources.find(item => item.id === source.id);
    if (state.collabRoomId || state.models.get(modelId)?.ifcDataStore !== model.ifcDataStore) throw new Error('The assignment model changed. Review its scope again.');
    if (!currentSource || JSON.stringify(logicalSource(currentSource)) !== sourceKey
      || !appearanceAssets.get(frozenSource.assetId ?? frozenSource.id)) throw new Error('The assignment source changed. Review its image and mapping again.');
  };
  validate();
  const ids = appearanceScope(snapshot.catalog, owners.selectedProductIds, scope).productIds;
  if (!ids.length) throw new Error('Choose a scope containing IFC objects.');
  const members = ids.map(expressId => ({ expressId, GlobalId: assignmentProductGlobalId(snapshot, expressId) }));
  const query: AssignmentQuery = scope.kind === 'selection' ? { kind: 'selection', GlobalIds: members.map(product => product.GlobalId) }
    : scope.kind === 'type' ? { kind: 'type', GlobalId: assignmentProductGlobalId(snapshot, scope.typeId) }
      : scope.kind === 'class' ? scope : { kind: 'model' };
  const sourceSha256 = await model.ifcDataStore.source.withMaterializedAsync(computeFullSourceHash);
  validate();
  if (!sourceSha256) throw new Error('The model source identity could not be verified. Try preparing the assignment again.');
  const assignment: AppearanceAssignment = { id: crypto.randomUUID(),
    model: { slotId: options.slotId, modelId, name: model.name, sourceSha256, revision: snapshot.revision },
    source: frozenSource, settings, query, members, excludedGlobalIds: [] };
  resolveAppearanceAssignments([assignment]);
  return { assignment, snapshot, validate };
}
