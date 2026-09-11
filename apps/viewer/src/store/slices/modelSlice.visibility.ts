/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelSlice`'s per-model field writes, beside the slice rather than inside
 * it (`modelSlice.ts` carries a recorded budget in
 * `scripts/module-size-allowlist.txt`; the `modelSlice.upsert.ts` pattern).
 *
 * `setModelVisibility`, `setModelCollapsed` and `setModelName` were three
 * copies of the same seven lines; {@link modelFieldPatch} is that once. The
 * two batched writes exist for the hierarchy's "Isolate matching models"
 * action (#4215): a federation of N models must flip in ONE store write, not
 * N — every subscriber (the renderer's model visibility, the tree) would
 * otherwise re-render N times, and a subscriber reading a half-applied
 * federation could see an isolate that hides nothing yet.
 *
 * Model ids are deduplicated through a `Set`: a model listed under several
 * tag groups is still one model and is written once.
 */

import type { FederatedModel } from '../types.js';

/** The slice of state these read and write. Structural so tests need no store. */
export interface ModelsState {
  models: Map<string, FederatedModel>;
}

/** Overwrite `fields` on one model; `{}` (no write) when the model is not loaded. */
export function modelFieldPatch(
  state: ModelsState,
  modelId: string,
  fields: Partial<Pick<FederatedModel, 'visible' | 'collapsed' | 'name'>>,
): Partial<ModelsState> {
  const model = state.models.get(modelId);
  if (!model) return {};
  const models = new Map(state.models);
  models.set(modelId, { ...model, ...fields });
  return { models };
}

/**
 * Set `visible` on every loaded model in `modelIds` in one write. Ids that
 * are not loaded are ignored; when nothing would change, nothing is written
 * (so the `models` map identity — what memoised selectors key on — holds).
 */
export function modelsVisibilityPatch(
  state: ModelsState,
  modelIds: Iterable<string>,
  visible: boolean,
): Partial<ModelsState> {
  return applyVisibility(state, (id) => (targets(modelIds).has(id) ? visible : undefined));
}

/**
 * The hierarchy's "Isolate matching models" (#4215): every model in
 * `modelIds` shown, every OTHER loaded model hidden, in one write. This is
 * whole-model visibility (`FederatedModel.visible`), the same flag the
 * model row's eye toggles — it does not touch the entity-level
 * isolate/hide channels, so an element isolation a user set up stays as it
 * was.
 */
export function isolateModelsPatch(state: ModelsState, modelIds: Iterable<string>): Partial<ModelsState> {
  const keep = targets(modelIds);
  return applyVisibility(state, (id) => keep.has(id));
}

function targets(modelIds: Iterable<string>): ReadonlySet<string> {
  return modelIds instanceof Set ? modelIds : new Set(modelIds);
}

/** Apply `visibleFor(id)` (undefined = leave as is) across the federation; one map, or no write. */
function applyVisibility(
  state: ModelsState,
  visibleFor: (modelId: string) => boolean | undefined,
): Partial<ModelsState> {
  let models: Map<string, FederatedModel> | null = null;
  for (const [id, model] of state.models) {
    const visible = visibleFor(id);
    if (visible === undefined || model.visible === visible) continue;
    models ??= new Map(state.models);
    models.set(id, { ...model, visible });
  }
  return models ? { models } : {};
}
