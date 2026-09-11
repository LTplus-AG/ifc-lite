/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model tags (issue #4215): definitions + per-model assignments.
 *
 * Two maps, deliberately separate:
 *  - `modelTags`            — the vocabulary, keyed by tag id. Persisted to
 *                             localStorage; survives every teardown.
 *  - `modelTagAssignments`  — model id → set of tag ids. Session state, torn
 *                             down with the model (`modelTagsSlice.teardown.ts`)
 *                             and carried between machines by the federation
 *                             setup file.
 *
 * Renaming changes `name` only; the id — what saved rules hold — never moves.
 * Deleting a tag drops its assignments here, and leaves every rule that named
 * it UNRESOLVED (`lib/model-tags/types.ts`): the rule keeps the id, matches
 * nothing, and the editors say why. See `lib/model-tags/types.ts` for what
 * these are not (IFC `Tag`, plugin `SourceTag`).
 */

import type { StateCreator } from 'zustand';
import { normalizeModelTagName, type ModelTag } from '../../lib/model-tags/types.js';
import { loadPersistedModelTags, savePersistedModelTags } from '../../lib/model-tags/persistence.js';

export type ModelTagAssignments = ReadonlyMap<string, ReadonlySet<string>>;

export interface ModelTagsSlice {
  modelTags: ReadonlyMap<string, ModelTag>;
  modelTagAssignments: ModelTagAssignments;

  /** Create a tag; returns its id. Returns the EXISTING id when a tag of that
   *  name (case-insensitive) already exists, and `null` for a blank name. */
  createModelTag: (name: string, color?: string) => string | null;
  /** Rename; `false` (and no change) when the name is blank, or taken by another tag. */
  renameModelTag: (id: string, name: string) => boolean;
  setModelTagColor: (id: string, color: string | undefined) => void;
  /** Remove the definition and every assignment of it. Rules keep the id and become unresolved. */
  deleteModelTag: (id: string) => void;
  /** Re-create definitions by id (setup-file reopen). An id already present is
   *  left as is — the live name wins — so a saved rule referencing it stays valid. */
  upsertModelTagDefinitions: (tags: readonly ModelTag[]) => void;

  assignModelTags: (modelIds: readonly string[], tagIds: readonly string[]) => void;
  unassignModelTags: (modelIds: readonly string[], tagIds: readonly string[]) => void;
  /** Replace one model's whole tag set. Unknown tag ids are dropped. */
  setModelTags: (modelId: string, tagIds: readonly string[]) => void;
}

function persistedDefinitions(): Map<string, ModelTag> {
  return new Map(loadPersistedModelTags().map((t) => [t.id, t]));
}

/** Id of the tag named `name` (case-insensitive), if any. */
export function findModelTagByName(tags: ReadonlyMap<string, ModelTag>, name: string): ModelTag | undefined {
  const key = normalizeModelTagName(name);
  if (!key) return undefined;
  for (const tag of tags.values()) if (normalizeModelTagName(tag.name) === key) return tag;
  return undefined;
}

export const createModelTagsSlice: StateCreator<ModelTagsSlice, [], [], ModelTagsSlice> = (set, get) => {
  const commitDefinitions = (modelTags: Map<string, ModelTag>) => {
    savePersistedModelTags([...modelTags.values()]);
    set({ modelTags });
  };

  return {
    modelTags: persistedDefinitions(),
    modelTagAssignments: new Map(),

    createModelTag: (name, color) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const existing = findModelTagByName(get().modelTags, trimmed);
      if (existing) return existing.id;
      const id = crypto.randomUUID();
      const next = new Map(get().modelTags);
      next.set(id, { id, name: trimmed, ...(color ? { color } : {}) });
      commitDefinitions(next);
      return id;
    },

    renameModelTag: (id, name) => {
      const trimmed = name.trim();
      const tags = get().modelTags;
      const tag = tags.get(id);
      if (!tag || !trimmed) return false;
      const clash = findModelTagByName(tags, trimmed);
      if (clash && clash.id !== id) return false;
      if (tag.name === trimmed) return true;
      const next = new Map(tags);
      next.set(id, { ...tag, name: trimmed });
      commitDefinitions(next);
      return true;
    },

    setModelTagColor: (id, color) => {
      const tags = get().modelTags;
      const tag = tags.get(id);
      if (!tag || tag.color === color) return;
      const next = new Map(tags);
      const { color: _dropped, ...rest } = tag;
      next.set(id, color ? { ...rest, color } : rest);
      commitDefinitions(next);
    },

    deleteModelTag: (id) => {
      const tags = get().modelTags;
      if (!tags.has(id)) return;
      const nextTags = new Map(tags);
      nextTags.delete(id);
      const assignments = new Map<string, ReadonlySet<string>>();
      for (const [modelId, set] of get().modelTagAssignments) {
        if (!set.has(id)) { assignments.set(modelId, set); continue; }
        const rest = new Set(set);
        rest.delete(id);
        if (rest.size > 0) assignments.set(modelId, rest);
      }
      savePersistedModelTags([...nextTags.values()]);
      set({ modelTags: nextTags, modelTagAssignments: assignments });
    },

    upsertModelTagDefinitions: (tags) => {
      const current = get().modelTags;
      const next = new Map(current);
      let changed = false;
      for (const tag of tags) {
        if (next.has(tag.id)) continue;
        // A different id carrying the same name would leave two chips the user
        // cannot tell apart; the live definition keeps the name, the incoming
        // one is skipped. Assignments naming the skipped id are then simply
        // absent — `assignModelTags` drops unknown ids — not misattributed.
        if (findModelTagByName(next, tag.name)) continue;
        next.set(tag.id, { ...tag });
        changed = true;
      }
      if (changed) commitDefinitions(next);
    },

    assignModelTags: (modelIds, tagIds) => {
      const known = get().modelTags;
      const ids = tagIds.filter((t) => known.has(t));
      if (ids.length === 0 || modelIds.length === 0) return;
      const next = new Map(get().modelTagAssignments);
      let changed = false;
      for (const modelId of modelIds) {
        const prior = next.get(modelId);
        if (prior && ids.every((t) => prior.has(t))) continue;
        next.set(modelId, new Set([...(prior ?? []), ...ids]));
        changed = true;
      }
      if (changed) set({ modelTagAssignments: next });
    },

    unassignModelTags: (modelIds, tagIds) => {
      const next = new Map(get().modelTagAssignments);
      let changed = false;
      for (const modelId of modelIds) {
        const prior = next.get(modelId);
        if (!prior || !tagIds.some((t) => prior.has(t))) continue;
        const rest = new Set(prior);
        for (const t of tagIds) rest.delete(t);
        if (rest.size > 0) next.set(modelId, rest);
        else next.delete(modelId);
        changed = true;
      }
      if (changed) set({ modelTagAssignments: next });
    },

    setModelTags: (modelId, tagIds) => {
      const known = get().modelTags;
      const ids = new Set(tagIds.filter((t) => known.has(t)));
      const next = new Map(get().modelTagAssignments);
      if (ids.size > 0) next.set(modelId, ids);
      else next.delete(modelId);
      set({ modelTagAssignments: next });
    },
  };
};
