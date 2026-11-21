/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { mutationDenialMessage, type MutationDenialReason } from '@/store/mutation-permission';
import { getModelForRef } from '@/sdk/adapters/model-compat';
import { disabled, internal, invalidInput, unavailable } from './refusals';

/** Denials that clear by themselves: the viewer is busy, not forbidding the write. */
const TRANSIENT = new Set<MutationDenialReason>(['workflow-running', 'properties-loading']);
/** Denials about one model, which details.model_id names. */
const PER_MODEL = new Set<MutationDenialReason>(['model-unavailable', 'id-space-exhausted', 'properties-loading', 'properties-failed']);

/**
 * The refusal for an edit-gate denial (#10871). `details.denial` carries the gate's own reason code, and
 * `details.model_id` the model it refused when the denial is about one model.
 * - workflow-running, properties-loading: UNSUPPORTED_OPERATION (wait for it).
 * - id-space-exhausted: INVALID_INPUT wrong-target (this model takes no more edits this session; another one can).
 * - model-unavailable: UNSUPPORTED_OPERATION while the model is still loading, INTERNAL_ERROR when its load failed,
 *   INVALID_INPUT unknown-target when the named model is gone, and wrong-target when it has no editable IFC data or
 *   no model was named at all.
 * - properties-failed: INTERNAL_ERROR (the viewer could not load what an edit needs).
 * - switched-off, edit-mode, collab-role: PERMISSION_DENIED.
 */
export function mutationRefusal(denial: MutationDenialReason, modelId: string | undefined, prefix = '') {
  // model_id names the model only for denials about one model; gate-wide denials (edit mode, a workflow) name none.
  const message = `${prefix}${mutationDenialMessage(denial)}`, details = modelId === undefined || !PER_MODEL.has(denial) ? { denial } : { denial, model_id: modelId };
  if (TRANSIENT.has(denial)) return unavailable(message, details);
  if (denial === 'id-space-exhausted') return invalidInput('wrong-target', message, details);
  if (denial === 'model-unavailable') {
    // Resolved the way the gate resolves it, so the legacy source counts as present.
    const model = modelId === undefined ? undefined : getModelForRef(useViewerStore.getState(), modelId);
    const loadState = model && 'loadState' in model ? model.loadState : undefined;
    if (loadState === 'error') return internal(message, details);
    if (loadState !== undefined && loadState !== 'complete') return unavailable(message, details);
    return invalidInput(modelId !== undefined && !model ? 'unknown-target' : 'wrong-target', message, details);
  }
  if (denial === 'properties-failed') return internal(message, details);
  return disabled(message, details);
}
