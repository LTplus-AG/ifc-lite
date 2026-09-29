/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one way an edit enters history (#6232 D4), and how undo / redo move it
 * between change sets.
 *
 * `recordHistory` pushes the edit onto its model's undo stack, clears the
 * redo branch, marks the model dirty, bumps `mutationVersion`, and files the
 * edit in the active change set. With no active set, the first edit starts
 * one called "Unsaved changes" (the `ChangeSetManager.addMutation` rule in
 * `@ifc-lite/mutations`). Undo takes an edit out of its set; redo files it
 * back into the set it came from, or into the active set if that one was
 * discarded meanwhile.
 */

import { generateChangeSetId, type ChangeSet, type Mutation } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';

export const UNSAVED_CHANGE_SET_NAME = 'Unsaved changes';

type ChangeSetState = Pick<ViewerState, 'changeSets' | 'activeChangeSetId'>;
type HistoryState = ChangeSetState & Pick<ViewerState, 'undoStacks' | 'redoStacks' | 'dirtyModels' | 'mutationVersion'>;
type ChangeSetPatch = Partial<ChangeSetState>;
export type HistoryPatch = Pick<HistoryState, 'undoStacks' | 'redoStacks' | 'dirtyModels' | 'mutationVersion'> & ChangeSetPatch;

/**
 * The set each recorded edit was filed in. Keyed by the mutation object,
 * which the stacks move as is, so it survives undo and serves redo; nothing
 * outlives the history that holds the mutation.
 */
const filedIn = new WeakMap<Mutation, string>();

export function newChangeSet(name: string): ChangeSet {
  return { id: generateChangeSetId(), name, createdAt: Date.now(), mutations: [], applied: false };
}

/** Push `mutations` as the newest edit of `modelId`, and file them in the active change set. */
export function recordHistory(s: HistoryState, modelId: string, mutations: readonly Mutation[]): HistoryPatch {
  return {
    undoStacks: new Map(s.undoStacks).set(modelId, [...(s.undoStacks.get(modelId) ?? []), ...mutations]),
    redoStacks: new Map(s.redoStacks).set(modelId, []),
    dirtyModels: new Set(s.dirtyModels).add(modelId),
    mutationVersion: s.mutationVersion + 1,
    ...fileInChangeSet(s, mutations),
  };
}

/** File `mutations` in `targetId` if that set exists, else in the active set (started if there is none). */
function fileInChangeSet(s: ChangeSetState, mutations: readonly Mutation[], targetId?: string): ChangeSetPatch {
  if (mutations.length === 0) return {};
  const changeSets = new Map(s.changeSets);
  let activeChangeSetId = s.activeChangeSetId;
  let target = targetId === undefined ? undefined : changeSets.get(targetId);
  if (!target) {
    target = activeChangeSetId === null ? undefined : changeSets.get(activeChangeSetId);
    if (!target) {
      target = newChangeSet(UNSAVED_CHANGE_SET_NAME);
      activeChangeSetId = target.id;
    }
  }
  changeSets.set(target.id, { ...target, mutations: [...target.mutations, ...mutations] });
  for (const mutation of mutations) filedIn.set(mutation, target.id);
  return { changeSets, activeChangeSetId };
}

/**
 * Forget edits that history no longer holds (cleared, pruned with a removed
 * model, invalidated by a peer, released with an appearance command): they
 * leave every change set, so a set never lists an edit that cannot be undone
 * or redone. Every site that removes entries from the stacks other than by
 * undo / redo calls this (undo / redo use `moveChangeSetEntries`).
 */
export function dropFromChangeSets(s: ChangeSetState, gone: Iterable<Mutation> | ReadonlySet<string>): ChangeSetPatch {
  const ids = gone instanceof Set ? gone : new Set([...(gone as Iterable<Mutation>)].map((mutation) => mutation.id));
  if (ids.size === 0) return {};
  let changeSets: Map<string, ChangeSet> | null = null;
  for (const set of s.changeSets.values()) {
    if (!set.mutations.some((mutation) => ids.has(mutation.id))) continue;
    changeSets ??= new Map(s.changeSets);
    changeSets.set(set.id, { ...set, mutations: set.mutations.filter((mutation) => !ids.has(mutation.id)) });
  }
  return changeSets ? { changeSets } : {};
}

/** The stacks of `modelId` emptied (its undo entries also leave their change sets). */
export function clearModelHistory(s: HistoryState, modelId: string): Pick<HistoryState, 'undoStacks' | 'redoStacks'> & ChangeSetPatch {
  return {
    undoStacks: new Map(s.undoStacks).set(modelId, []),
    redoStacks: new Map(s.redoStacks).set(modelId, []),
    ...dropFromChangeSets(s, s.undoStacks.get(modelId) ?? []),
  };
}

/** Undo takes `moved` out of their change sets; redo files them back where they were. */
export function moveChangeSetEntries(s: ChangeSetState, moved: readonly Mutation[], direction: 'undo' | 'redo'): ChangeSetPatch {
  if (direction === 'undo') {
    const bySet = new Map<string, Set<Mutation>>();
    for (const mutation of moved) {
      const id = filedIn.get(mutation);
      if (id !== undefined && s.changeSets.has(id)) bySet.set(id, (bySet.get(id) ?? new Set()).add(mutation));
    }
    if (bySet.size === 0) return {};
    const changeSets = new Map(s.changeSets);
    for (const [id, gone] of bySet) {
      const set = changeSets.get(id)!;
      changeSets.set(id, { ...set, mutations: set.mutations.filter((mutation) => !gone.has(mutation)) });
    }
    return { changeSets };
  }
  // Redo pops the redo stack newest-undone first, which is the original order.
  // One append per target set: a Bulk batch can be thousands of edits.
  const byTarget = new Map<string | undefined, Mutation[]>();
  for (const mutation of moved) {
    const id = filedIn.get(mutation);
    const key = id !== undefined && s.changeSets.has(id) ? id : undefined;
    const run = byTarget.get(key);
    if (run) run.push(mutation);
    else byTarget.set(key, [mutation]);
  }
  let state: ChangeSetState = s;
  for (const [id, mutations] of byTarget) state = { ...state, ...fileInChangeSet(state, mutations, id) };
  return { changeSets: state.changeSets, activeChangeSetId: state.activeChangeSetId };
}

/**
 * Read an exported change set file (`exportChangeSet`'s format). A new id
 * avoids clashing with the set it was exported from. Null when the text is
 * not a change set.
 */
export function parseChangeSetFile(json: string): ChangeSet | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    console.warn('Change set file is not JSON:', error);
    return null;
  }
  const changeSet = (data as { changeSet?: Partial<ChangeSet> } | null)?.changeSet;
  if (!changeSet || typeof changeSet.name !== 'string' || !Array.isArray(changeSet.mutations)) return null;
  return {
    id: generateChangeSetId(),
    name: changeSet.name,
    createdAt: typeof changeSet.createdAt === 'number' ? changeSet.createdAt : Date.now(),
    mutations: changeSet.mutations,
    applied: false,
  };
}
