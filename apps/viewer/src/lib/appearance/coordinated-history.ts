/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store/index.js';
import type { AppearanceHistoryPublication } from './history.js';

export interface AppearanceHistoryParticipant {
  modelId: string;
  view: MutablePropertyView;
  mutations: readonly Mutation[];
}
interface Command {
  replay(direction: 'undo' | 'redo'): AppearanceHistoryPublication;
  dispose(): void;
}
interface Member { modelId: string; view: MutablePropertyView; marker: Mutation }
interface Group { members: Member[]; command: Command }
interface Registry { groups: Set<Group>; markers: Map<string, Group>; unsubscribe(): void; replaying: boolean }
const registries = new WeakMap<StoreApi<ViewerState>['getState'], Registry>();

function prune(store: StoreApi<ViewerState>, registry: Registry): void {
  const state = store.getState(), stale = new Set<string>();
  for (const group of registry.groups) {
    if (group.members.every(member => state.models.has(member.modelId)
      && state.mutationViews.get(member.modelId) === member.view
      && [...(state.undoStacks.get(member.modelId) ?? []), ...(state.redoStacks.get(member.modelId) ?? [])]
        .some(mutation => mutation.id === member.marker.id))) continue;
    registry.groups.delete(group);
    for (const member of group.members) { stale.add(member.marker.id); registry.markers.delete(member.marker.id); }
    try { group.command.dispose(); }
    catch (error) { console.error('Failed to release coordinated appearance history', error); }
  }
  if (!registry.groups.size) { registry.unsubscribe(); registries.delete(store.getState); }
  if (stale.size) {
    const omit = (stacks: Map<string, Mutation[]>) => new Map([...stacks]
      .map(([id, values]) => [id, values.filter(value => !stale.has(value.id))]));
    store.setState(current => ({ undoStacks: omit(current.undoStacks), redoStacks: omit(current.redoStacks) }));
  }
}

/** One command has a marker in each participant's ordinary history order. All
 * markers are installed together; no model owns a separately replayable fragment. */
export function prepareCoordinatedAppearanceHistory(store: StoreApi<ViewerState>, participants: readonly AppearanceHistoryParticipant[], command: Command) {
  if (!participants.length || new Set(participants.map(member => member.modelId)).size !== participants.length) {
    throw new Error('Coordinated appearance history needs distinct target models.');
  }
  const state = store.getState(), allIds = new Set<string>();
  const members: Member[] = participants.map(participant => {
    const { modelId, view, mutations } = participant, marker = mutations.at(-1);
    const applied = new Set(view.getMutations().map(mutation => mutation.id));
    const recorded = new Set([...(state.undoStacks.get(modelId) ?? []), ...(state.redoStacks.get(modelId) ?? [])].map(mutation => mutation.id));
    if (!state.models.has(modelId) || state.mutationViews.get(modelId) !== view || !marker
      || mutations.some(mutation => mutation.modelId !== modelId || !applied.has(mutation.id) || recorded.has(mutation.id) || allIds.has(mutation.id))) {
      throw new Error('Coordinated appearance history requires unrecorded mutations on every current model.');
    }
    for (const mutation of mutations) {
      if (allIds.has(mutation.id)) throw new Error('Coordinated appearance history repeats a mutation.');
      allIds.add(mutation.id);
    }
    return { modelId, view, marker };
  });
  let committed = false;
  return (publication: AppearanceHistoryPublication) => {
    if (committed) return;
    committed = true;
    let registry = registries.get(store.getState);
    if (!registry) {
      registry = { groups: new Set(), markers: new Map(), unsubscribe() {}, replaying: false };
      const owned = registry;
      registry.unsubscribe = store.subscribe((current, previous) => {
        if (current.models !== previous.models || current.mutationViews !== previous.mutationViews
          || current.undoStacks !== previous.undoStacks || current.redoStacks !== previous.redoStacks) prune(store, owned);
      });
      registries.set(store.getState, registry);
    }
    const group = { members, command };
    registry.groups.add(group);
    for (const member of members) registry.markers.set(member.marker.id, group);
    store.setState(current => {
      const undoStacks = new Map(current.undoStacks), redoStacks = new Map(current.redoStacks), dirtyModels = new Set(current.dirtyModels);
      for (const member of members) {
        undoStacks.set(member.modelId, [...(undoStacks.get(member.modelId) ?? []), member.marker]);
        redoStacks.set(member.modelId, []); dirtyModels.add(member.modelId);
      }
      return { ...publication, undoStacks, redoStacks, dirtyModels, mutationVersion: current.mutationVersion + 1 };
    });
  };
}

/** A newer edit in any participant must be undone before this shared command.
 * A failed replay leaves all history stacks where they were. */
export function replayCoordinatedAppearanceHistory(store: StoreApi<ViewerState>, modelId: string, direction: 'undo' | 'redo'): boolean {
  const registry = registries.get(store.getState);
  if (!registry) return false;
  const source = direction === 'undo' ? 'undoStacks' : 'redoStacks', destination = direction === 'undo' ? 'redoStacks' : 'undoStacks';
  const state = store.getState(), marker = state[source].get(modelId)?.at(-1), group = marker && registry.markers.get(marker.id);
  if (!group) return false;
  if (registry.replaying) throw new Error('A coordinated appearance command is already replaying.');
  for (const member of group.members) {
    if (state.mutationViews.get(member.modelId) !== member.view || !state.models.has(member.modelId)) throw new Error('An appearance target was removed or reloaded.');
    if (state[source].get(member.modelId)?.at(-1)?.id !== member.marker.id) {
      throw new Error(`First ${direction} the newer changes in ${state.models.get(member.modelId)?.name ?? member.modelId}. This appearance spans several models.`);
    }
  }
  registry.replaying = true;
  let publication: AppearanceHistoryPublication;
  try { publication = group.command.replay(direction); }
  finally { registry.replaying = false; }
  store.setState(current => {
    const from = new Map(current[source]), to = new Map(current[destination]);
    for (const member of group.members) {
      from.set(member.modelId, from.get(member.modelId)!.slice(0, -1));
      to.set(member.modelId, [...(to.get(member.modelId) ?? []), member.marker]);
    }
    return { ...publication, [source]: from, [destination]: to, mutationVersion: current.mutationVersion + 1 };
  });
  return true;
}
