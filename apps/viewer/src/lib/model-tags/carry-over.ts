/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry model tag assignments across an EXPLICIT reload of a model (#4215).
 *
 * Assignments are keyed by model id and die with the model
 * (`modelTagsSlice.teardown.ts`). Two paths replace a model on purpose and
 * must keep its tags: the toolbar's Refresh (federation: `clearAllModels` then
 * `addModel` under the SAME id; single model: `loadFile` under a NEW id) and a
 * cloud-source Sync (`addModel` under a new id, then `removeModel` of the old).
 * Both go through the canonical load path, and both call this pair around it:
 * capture BEFORE the teardown that drops the assignment, restore AFTER the
 * replacement's id is known.
 *
 * Only an explicit replacement carries tags. Opening another file that merely
 * shares a filename is a new model and inherits nothing — there is no
 * name-keyed lookup here, only the captured id.
 */

export type ModelTagCarryOver = ReadonlyMap<string, readonly string[]>;

/** Snapshot every model's tag ids (or just `modelIds`') before a teardown. */
export function captureModelTags(
  state: { modelTagAssignments: ReadonlyMap<string, ReadonlySet<string>> },
  modelIds?: readonly string[],
): ModelTagCarryOver {
  const out = new Map<string, string[]>();
  for (const [modelId, tags] of state.modelTagAssignments) {
    if (modelIds && !modelIds.includes(modelId)) continue;
    if (tags.size > 0) out.set(modelId, [...tags]);
  }
  return out;
}

/** Put the tags captured for `previousId` onto `replacementId` (no-op when none were captured). */
export function restoreModelTags(
  state: { assignModelTags: (modelIds: readonly string[], tagIds: readonly string[]) => void },
  carry: ModelTagCarryOver,
  previousId: string,
  replacementId: string,
): void {
  const tags = carry.get(previousId);
  if (tags && tags.length > 0) state.assignModelTags([replacementId], tags);
}
