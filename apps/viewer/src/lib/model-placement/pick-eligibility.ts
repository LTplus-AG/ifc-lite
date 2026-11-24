/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models a reposition pick may land on. One rule, read by the pick
 * hook's `accepts` filter, the pick prompt and the wrong-model click message,
 * so the three cannot disagree.
 *
 * Source points snap to MOVING models; target points snap to NON-moving
 * models, narrowed to the chosen reference model when one is set. A hidden
 * model is never eligible.
 */
export type PickRole = 'source' | 'target';

export interface PickEligibilityContext {
  /** Ids of the models being moved (`preview.before` keys). */
  readonly moving: ReadonlySet<string>;
  /** Chosen reference model id, or '' when none. */
  readonly reference: string;
  /** Whether the model is loaded and visible. */
  readonly isVisible: (modelId: string) => boolean;
}

export function isEligiblePickModel(role: PickRole, modelId: string, ctx: PickEligibilityContext): boolean {
  return (role === 'source') === ctx.moving.has(modelId) && ctx.isVisible(modelId) &&
    (role === 'source' || !ctx.reference || modelId === ctx.reference);
}

export function eligiblePickModelIds(role: PickRole, modelIds: Iterable<string>, ctx: PickEligibilityContext): string[] {
  return [...modelIds].filter((id) => isEligiblePickModel(role, id, ctx));
}

/** Catalogue key of the pick prompt (params: `{models}`); the generic one when no model is eligible. */
export function pickPromptKey(role: PickRole, eligibleCount: number, referenceSet: boolean) {
  if (eligibleCount === 0) return 'repositionPanel.pickPrompt' as const;
  if (role === 'source') return 'repositionPanel.pickPromptSource' as const;
  return referenceSet ? 'repositionPanel.pickPromptTargetReference' as const : 'repositionPanel.pickPromptTarget' as const;
}

/** Context from the store's models map and the preview's moving ids. */
export function pickContext(
  moving: ReadonlySet<string>, reference: string, models: ReadonlyMap<string, { visible?: boolean }>,
): PickEligibilityContext {
  return { moving, reference, isVisible: (id) => !!models.get(id)?.visible };
}

export type RejectedPickKey =
  | 'repositionPanel.errorNotMoving'
  | 'repositionPanel.errorIsMoving'
  | 'repositionPanel.errorNotReference'
  | 'repositionPanel.errorNoPoint';

export interface RejectedPickMessage { key: RejectedPickKey; params: { hit: string; expected: string } }

/**
 * Message for a click that found no eligible point. `hitModelId` is the model
 * an unrestricted raycast hit, or null when it hit nothing. A hit on an
 * eligible or unknown model keeps the generic message.
 */
export function rejectedPickMessage(
  role: PickRole, hitModelId: string | null, ctx: PickEligibilityContext,
  modelIds: Iterable<string>, nameOf: (modelId: string) => string,
): RejectedPickMessage {
  const generic: RejectedPickMessage = { key: 'repositionPanel.errorNoPoint', params: { hit: '', expected: '' } };
  if (hitModelId === null || !ctx.isVisible(hitModelId) || isEligiblePickModel(role, hitModelId, ctx)) return generic;
  const expected = eligiblePickModelIds(role, modelIds, ctx).map(nameOf).join(', ');
  // Nothing eligible (e.g. the only moving model is hidden): naming a model to
  // pick instead would end the sentence on an empty list.
  if (expected === '') return generic;
  const hit = nameOf(hitModelId);
  if (role === 'source') return { key: 'repositionPanel.errorNotMoving', params: { hit, expected } };
  if (ctx.moving.has(hitModelId)) return { key: 'repositionPanel.errorIsMoving', params: { hit, expected } };
  return { key: 'repositionPanel.errorNotReference', params: { hit, expected } };
}
