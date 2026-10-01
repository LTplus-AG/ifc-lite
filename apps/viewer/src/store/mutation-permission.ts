/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { areWorkflowModelsReadLocked } from '../lib/flow/run-session.js';
import type { ViewerState } from './index.js';
import { getModelForRef } from '../sdk/adapters/model-compat.js';

type MutationPermissionState = Pick<ViewerState, 'editEnabled' | 'canCollabEdit' | 'models' | 'ifcDataStore'>;

export type MutationDenialReason = 'edit-mode' | 'collab-role' | 'model-unavailable' | 'workflow-running';

export function mutationDenialKey(reason: MutationDenialReason) {
  switch (reason) {
    case 'workflow-running': return 'mutationPermission.workflowRunning' as const;
    case 'edit-mode': return 'mutationPermission.editModeRequired' as const;
    case 'collab-role': return 'mutationPermission.roleRequired' as const;
    case 'model-unavailable': return 'mutationPermission.modelUnavailable' as const;
  }
}

/** One policy for viewer authoring, including direct overlay clients and scripts (#5901). */
export function mutationPermission(
  state: MutationPermissionState,
  modelId?: string,
): { allowed: true } | { allowed: false; reason: MutationDenialReason } {
  if (areWorkflowModelsReadLocked()) return { allowed: false, reason: 'workflow-running' };
  if (!state.editEnabled) return { allowed: false, reason: 'edit-mode' };
  if (!state.canCollabEdit()) return { allowed: false, reason: 'collab-role' };
  if (modelId !== undefined && !getModelForRef(state, modelId)?.ifcDataStore) {
    return { allowed: false, reason: 'model-unavailable' };
  }
  return { allowed: true };
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

export function mutationDenialMessage(reason: MutationDenialReason): string {
  switch (reason) {
    case 'workflow-running': return 'Wait for the workflow check or PDF capture to finish, or cancel the workflow';
    case 'edit-mode': return 'Turn on Edit mode before changing a model';
    case 'collab-role': return 'Editing is disabled for your role in this shared session';
    case 'model-unavailable': return 'This model has no editable IFC data';
  }
}

export function mutationDenial(state: MutationPermissionState, modelId?: string): string | null {
  const permission = mutationPermission(state, modelId);
  return permission.allowed ? null : mutationDenialMessage(permission.reason);
}
