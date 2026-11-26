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
 * eligible or unknown model keeps the generic message. `pickable` narrows the
 * expected list the same way the prompt does (see `pickableFilter`); labels
 * still count every loaded model.
 */
export function rejectedPickMessage(
  role: PickRole, hitModelId: string | null, ctx: PickEligibilityContext,
  modelIds: Iterable<string>, nameOf: (modelId: string) => string,
  pickable: (eligible: string[]) => string[] = (eligible) => eligible,
): RejectedPickMessage {
  const generic: RejectedPickMessage = { key: 'repositionPanel.errorNoPoint', params: { hit: '', expected: '' } };
  if (hitModelId === null || !ctx.isVisible(hitModelId) || isEligiblePickModel(role, hitModelId, ctx)) return generic;
  const all = [...modelIds];
  const labels = modelLabels(all, nameOf);
  const label = (id: string) => labels.get(id) ?? nameOf(id);
  const expected = pickable(eligiblePickModelIds(role, all, ctx)).map(label).join(', ');
  // Nothing pickable (e.g. the only moving model is hidden): naming a model to
  // pick instead would end the sentence on an empty list.
  if (expected === '') return generic;
  const hit = label(hitModelId);
  if (role === 'source') return { key: 'repositionPanel.errorNotMoving', params: { hit, expected } };
  if (ctx.moving.has(hitModelId)) return { key: 'repositionPanel.errorIsMoving', params: { hit, expected } };
  return { key: 'repositionPanel.errorNotReference', params: { hit, expected } };
}

/**
 * Display label per model. Models sharing a name get a load-order ordinal
 * ("A.ifc (1)", "A.ifc (2)") so a list never reads "A.ifc, A.ifc"; unique
 * names stay as they are.
 */
export function modelLabels(modelIds: Iterable<string>, nameOf: (modelId: string) => string): Map<string, string> {
  const ids = [...modelIds];
  const total = new Map<string, number>();
  for (const id of ids) total.set(nameOf(id), (total.get(nameOf(id)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const id of ids) {
    const name = nameOf(id);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    labels.set(id, (total.get(name) ?? 0) > 1 ? `${name} (${n})` : name);
  }
  return labels;
}

/**
 * Of the eligible models, those with at least one entity the pick can still
 * land on: not hidden and, when an isolation set is active, inside it. A model
 * with no known entity ids (e.g. instanced-only geometry) is kept, since its
 * visibility cannot be judged from here.
 */
export function pickableModelIds(
  modelIds: readonly string[], entityIdsOf: (modelId: string) => Iterable<number>,
  hidden: ReadonlySet<number>, isolated: ReadonlySet<number> | null,
): string[] {
  return modelIds.filter((id) => {
    let any = false;
    for (const entityId of entityIdsOf(id)) {
      any = true;
      if (!hidden.has(entityId) && (isolated === null || isolated.has(entityId))) return true;
    }
    return !any;
  });
}

/** `pickableModelIds` bound to the store's models and hidden/isolation sets, for the prompt and the rejection message alike. */
export function pickableFilter(
  models: ReadonlyMap<string, Parameters<typeof modelEntityIds>[0]>,
  hidden: ReadonlySet<number>, isolated: ReadonlySet<number> | null,
): (eligible: string[]) => string[] {
  return (eligible) => pickableModelIds(eligible, (id) => modelEntityIds(models.get(id)), hidden, isolated);
}

/** Hidden and isolation sets for the click-time raycast that explains a refusal: the same ones the pick respects, without the model restriction. */
export function explainRaycastFilter(
  state: { hiddenEntities: Set<number>; isolatedEntities: Set<number> | null },
): { hiddenIds: Set<number>; isolatedIds: Set<number> | undefined } {
  return { hiddenIds: state.hiddenEntities, isolatedIds: state.isolatedEntities ?? undefined };
}

/** Model an unrestricted raycast hit (snap target first), or null for no hit. */
export function hitModelId(
  result: { snapTarget?: { expressId: number } | null; intersection?: { expressId: number } | null },
  modelOf: (expressId: number) => string,
): string | null {
  const id = result.snapTarget?.expressId ?? result.intersection?.expressId;
  return id === undefined ? null : modelOf(id);
}

/** Entity ids a model's meshes and point clouds contribute to a pick (the ids the hidden/isolation sets are keyed by). */
export function modelEntityIds(
  model: { geometryResult?: {
    meshes?: ReadonlyArray<{ expressId: number; entityIds?: ArrayLike<number> }>;
    pointClouds?: ReadonlyArray<{ expressId: number }>;
  } | null } | undefined,
): number[] {
  const ids: number[] = [];
  for (const mesh of model?.geometryResult?.meshes ?? []) {
    if (mesh.entityIds) for (let i = 0; i < mesh.entityIds.length; i++) ids.push(mesh.entityIds[i]);
    else ids.push(mesh.expressId);
  }
  for (const cloud of model?.geometryResult?.pointClouds ?? []) ids.push(cloud.expressId);
  return ids;
}
