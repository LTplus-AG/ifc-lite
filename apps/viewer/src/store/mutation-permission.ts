/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { areWorkflowModelsReadLocked } from '../lib/flow/run-session.js';
import type { ViewerState } from './index.js';
import { getModelForRef } from '../sdk/adapters/model-compat.js';

type MutationPermissionState = Pick<ViewerState, 'editEnabled' | 'canCollabEdit' | 'models' | 'ifcDataStore'> & Partial<Pick<ViewerState, 'serverPropertiesRuns' | 'mutationViews'>>;

export type MutationDenialReason = 'edit-mode' | 'collab-role' | 'model-unavailable' | 'workflow-running' | 'properties-loading' | 'properties-failed' | 'id-space-exhausted';

export function mutationDenialKey(reason: MutationDenialReason) {
  switch (reason) {
    case 'workflow-running': return 'mutationPermission.workflowRunning' as const;
    case 'edit-mode': return 'mutationPermission.editModeRequired' as const;
    case 'collab-role': return 'mutationPermission.roleRequired' as const;
    case 'model-unavailable': return 'mutationPermission.modelUnavailable' as const;
    case 'properties-loading': return 'mutationPermission.propertiesLoading' as const;
    case 'properties-failed': return 'mutationPermission.propertiesFailed' as const;
    case 'id-space-exhausted': return 'mutationPermission.idSpaceExhausted' as const;
  }
}

/** One policy for viewer authoring, including direct overlay clients and scripts (#5901). */
export function mutationPermission(
  state: MutationPermissionState,
  modelId?: string,
): { allowed: true } | { allowed: false; reason: MutationDenialReason } {
  // A running workflow is named first: turning on Edit mode would not unblock it.
  if (areWorkflowModelsReadLocked()) return { allowed: false, reason: 'workflow-running' };
  if (!state.editEnabled) return { allowed: false, reason: 'edit-mode' };
  return dataMutationPermission(state, modelId);
}

/** In-place data edits keep the current workspace; all write locks still apply. */
export function dataMutationPermission(state: MutationPermissionState, modelId?: string): ReturnType<typeof mutationPermission> {
  if (areWorkflowModelsReadLocked()) return { allowed: false, reason: 'workflow-running' };
  if (!state.canCollabEdit()) return { allowed: false, reason: 'collab-role' };
  // A server-loaded model gets its data model after registration, and the id range it owns grows
  // then (`extendModel`). An id authored before that would collide with a hydrated entity, so no
  // overlay id is allocated until the properties are in.
  const properties = modelId === undefined ? undefined : state.serverPropertiesRuns?.get(modelId)?.kind;
  if (properties === 'running') return { allowed: false, reason: 'properties-loading' };
  if (properties === 'failed') return { allowed: false, reason: 'properties-failed' };
  if (modelId !== undefined) {
    const model = getModelForRef(state, modelId);
    if (!model?.ifcDataStore) return { allowed: false, reason: 'model-unavailable' };
    if (state.models.get(modelId)?.hasOverlayCapacity === false) {
      return { allowed: false, reason: 'id-space-exhausted' };
    }
  }
  return { allowed: true };
}

export function canMutateData(state: MutationPermissionState, modelId?: string): boolean {
  return dataMutationPermission(state, modelId).allowed;
}

export function canMutate(state: MutationPermissionState, modelId?: string): boolean {
  return mutationPermission(state, modelId).allowed;
}

/** A batch is writable only when every target model is writable. */
export function mutationPermissionForModels(state: MutationPermissionState, modelIds: Iterable<string>) {
  let hasTarget = false;
  for (const modelId of modelIds) {
    if (!modelId) return { allowed: false, reason: 'model-unavailable' } as const;
    hasTarget = true;
    const permission = mutationPermission(state, modelId);
    if (!permission.allowed) return permission;
  }
  return hasTarget ? { allowed: true } as const : { allowed: false, reason: 'model-unavailable' } as const;
}

export function dataMutationPermissionForModels(state: MutationPermissionState, modelIds: Iterable<string>) {
  let hasTarget = false;
  for (const modelId of modelIds) {
    if (!modelId) return { allowed: false, reason: 'model-unavailable' } as const;
    hasTarget = true;
    const permission = dataMutationPermission(state, modelId);
    if (!permission.allowed) return permission;
  }
  return hasTarget ? { allowed: true } as const : { allowed: false, reason: 'model-unavailable' } as const;
}

export function mutationDenialMessage(reason: MutationDenialReason): string {
  switch (reason) {
    case 'workflow-running': return 'Wait for the workflow check or PDF capture to finish, or cancel the workflow';
    case 'edit-mode': return 'Turn on Edit mode before changing a model';
    case 'collab-role': return 'Editing is disabled for your role in this shared session';
    case 'model-unavailable': return 'This model has no editable IFC data';
    case 'properties-loading': return 'The model\'s properties are still loading';
    case 'properties-failed': return 'The model\'s properties could not be loaded, so it cannot be edited';
    case 'id-space-exhausted': return 'This model does not have enough safe entity IDs for edits in this session';
  }
}

export function mutationDenial(state: MutationPermissionState, modelId?: string): string | null {
  const permission = mutationPermission(state, modelId);
  return permission.allowed ? null : mutationDenialMessage(permission.reason);
}
